import type {
  ReleaseObjectCondition,
  ReleaseObjectMetadata,
  ReleaseObjectRead,
  ReleaseObjectStore,
  ReleaseObjectWrite,
  ReleaseObjectWriteResult,
} from "./release-object-store";
import { ReleaseObjectStorageUnavailableError } from "./release-object-store";

type R2ReleaseBucket = Pick<R2Bucket, "head" | "get" | "put">;

function unavailable(): ReleaseObjectStorageUnavailableError {
  // Do not retain the provider error as `cause`: this boundary is intentionally
  // content-free and callers already classify the operation phase.
  return new ReleaseObjectStorageUnavailableError();
}

function metadata(object: R2Object): ReleaseObjectMetadata {
  const version = object.etag;
  const httpEtag = object.httpEtag;
  if (typeof version !== "string"
      || version.length === 0
      || typeof httpEtag !== "string"
      || httpEtag.length === 0
      || !Number.isSafeInteger(object.size)
      || object.size < 0) {
    throw unavailable();
  }
  return Object.freeze({
    // R2's ETag is the first implementation's opaque conditional token. The
    // portable contract deliberately exposes it as `version`, while retaining
    // both aliases for the existing HTTP expected-state protocol.
    version,
    size: object.size,
    entityTags: Object.freeze([version, httpEtag]),
    contentType: object.httpMetadata?.contentType,
    cacheControl: object.httpMetadata?.cacheControl,
  });
}

function condition(condition: ReleaseObjectCondition): R2Conditional {
  if (condition === null || typeof condition !== "object") throw unavailable();
  if (condition.kind === "absent") return { etagDoesNotMatch: "*" };
  if (condition.kind === "version"
      && typeof condition.version === "string"
      && condition.version.length > 0) {
    return { etagMatches: condition.version };
  }
  // Never let malformed input fall through to an R2 call with an undefined
  // precondition, which would turn a conditional write into an unconditional
  // write at the provider boundary.
  throw unavailable();
}

function validSha256(value: unknown): value is ArrayBuffer | Uint8Array {
  return (value instanceof ArrayBuffer || value instanceof Uint8Array)
    && value.byteLength === 32;
}

function hasArrayBuffer(
  value: R2Object | R2ObjectBody,
): value is R2ObjectBody {
  try {
    return typeof Reflect.get(value, "arrayBuffer") === "function";
  } catch {
    throw unavailable();
  }
}

export function createR2ReleaseObjectStore(
  bucket: R2ReleaseBucket,
): ReleaseObjectStore {
  return {
    async head(key: string): Promise<ReleaseObjectMetadata | null> {
      let object: R2Object | null;
      try {
        object = await bucket.head(key);
      } catch {
        throw unavailable();
      }
      if (object === null) return null;
      try {
        return metadata(object);
      } catch (error) {
        if (error instanceof ReleaseObjectStorageUnavailableError) throw error;
        throw unavailable();
      }
    },

    async get(key: string, version: string): Promise<ReleaseObjectRead> {
      if (typeof version !== "string" || version.length === 0) {
        throw unavailable();
      }
      let object: R2Object | R2ObjectBody | null;
      try {
        object = await bucket.get(key, {
          onlyIf: { etagMatches: version },
        });
      } catch {
        throw unavailable();
      }
      if (object === null) return { status: "missing" };
      if (!hasArrayBuffer(object)) return { status: "conflict" };

      return {
        status: "found",
        // Reading is intentionally deferred so callers can decide whether the
        // conditional result is usable before allocating the body. A rejection
        // here is still a storage outage, but remains observable at the caller's
        // operation phase (for example `artifact_read`).
        async arrayBuffer(): Promise<ArrayBuffer> {
          try {
            return await object.arrayBuffer();
          } catch {
            throw unavailable();
          }
        },
      };
    },

    async put(
      key: string,
      bytes: Uint8Array,
      options: ReleaseObjectWrite,
    ): Promise<ReleaseObjectWriteResult> {
      let checksum: unknown;
      try {
        checksum = Reflect.get(options as object, "sha256");
      } catch {
        throw unavailable();
      }
      if (!validSha256(checksum)) throw unavailable();
      let object: R2Object | null;
      try {
        object = await bucket.put(key, bytes, {
          onlyIf: condition(options.condition),
          sha256: checksum,
          httpMetadata: {
            contentType: options.contentType,
            cacheControl: options.cacheControl,
          },
        });
      } catch {
        throw unavailable();
      }
      if (object === null) return { status: "conflict" };
      try {
        return { status: "stored", metadata: metadata(object) };
      } catch (error) {
        if (error instanceof ReleaseObjectStorageUnavailableError) throw error;
        throw unavailable();
      }
    },
  };
}

/**
 * Keep the binding check at the composition boundary. A partially configured
 * release bucket is equivalent to a disabled route; callers should not receive
 * an exception while deciding whether this optional surface is available.
 */
export function configuredR2ReleaseObjectStore(
  value: unknown,
): ReleaseObjectStore | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (typeof Reflect.get(value, "head") !== "function"
        || typeof Reflect.get(value, "get") !== "function"
        || typeof Reflect.get(value, "put") !== "function") {
      return null;
    }
  } catch {
    return null;
  }
  return createR2ReleaseObjectStore(value as R2ReleaseBucket);
}
