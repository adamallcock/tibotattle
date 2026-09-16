/** Storage contract for the release guard. Versions are opaque conditional-operation
 * tokens, not content hashes. Entity tags exist only for the current HTTP protocol's
 * expected-state check; callers must never use them as storage version tokens.
 */
export interface ReleaseObjectMetadata {
  readonly version: string;
  readonly size: number;
  /** Both raw and HTTP-quoted aliases accepted by the existing wire protocol.
   * These describe the current object, independently of its conditional token.
   */
  readonly entityTags: readonly string[];
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
}

/** Missing/conflict are definitive provider results. Transport, permission,
 * integrity and body-read failures reject with ReleaseObjectStorageUnavailableError.
 */
export type ReleaseObjectRead =
  | { readonly status: "missing" | "conflict" }
  | { readonly status: "found"; readonly arrayBuffer: () => Promise<ArrayBuffer> };

export type ReleaseObjectCondition =
  | { readonly kind: "absent" }
  | { readonly kind: "version"; readonly version: string };

export interface ReleaseObjectWrite {
  readonly condition: ReleaseObjectCondition;
  /** Required 32-byte content digest. The adapter must enforce it before commit,
   * locally or through the provider's integrity check; it is not a CAS token.
   */
  readonly sha256: ArrayBuffer | Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
}

export type ReleaseObjectWriteResult =
  | { readonly status: "conflict" }
  | { readonly status: "stored"; readonly metadata: ReleaseObjectMetadata };

/** No unconditional reads/writes: the guard verifies precisely the object it
 * inspected and may replace only that version, or create an absent object.
 * Conditional get checks the CURRENT live object; retrieving a historical
 * version after the live object changed does not satisfy this contract.
 * Persist and return the supplied contentType/cacheControl without silently
 * weakening their exact guard comparisons.
 * Preconditions must be atomic at the provider; never retry unconditionally.
 * The caller bounds object size before reading, verifies bytes/signatures, and
 * maps storage failures to its content-free public error and operation phase.
 * This does not transact with the separate replay-nonce database.
 */
export interface ReleaseObjectStore {
  head(key: string): Promise<ReleaseObjectMetadata | null>;
  get(key: string, version: string): Promise<ReleaseObjectRead>;
  put(key: string, bytes: Uint8Array, options: ReleaseObjectWrite): Promise<ReleaseObjectWriteResult>;
}

export class ReleaseObjectStorageUnavailableError extends Error {
  constructor() { super("RELEASE_OBJECT_STORAGE_UNAVAILABLE"); }
}
