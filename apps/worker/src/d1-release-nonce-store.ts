import {
  ReleaseNonceStorageUnavailableError,
  type ReleaseNonceConsumeOptions,
  type ReleaseNonceStore,
} from "./release-nonce-store";

/** The D1 surface required by this adapter; the portable contract imports none of it. */
export type D1ReleaseNonceDatabase = Pick<D1Database, "prepare" | "batch">;

const DELETE_EXPIRED_NONCES =
  "DELETE FROM sparkle_appcast_guard_nonces WHERE expires_at <= ?";
const INSERT_NONCE =
  "INSERT OR IGNORE INTO sparkle_appcast_guard_nonces (nonce, expires_at) VALUES (?, ?)";

function unavailable(): ReleaseNonceStorageUnavailableError {
  // Never retain a provider error as a cause. The caller already knows which
  // guard phase failed and the public error must not expose database details.
  return new ReleaseNonceStorageUnavailableError();
}

function validWindow(
  nonce: unknown,
  options: ReleaseNonceConsumeOptions,
): options is ReleaseNonceConsumeOptions {
  if (typeof nonce !== "string" || nonce.length === 0) return false;
  let nowSeconds: unknown;
  let expiresAtSeconds: unknown;
  try {
    nowSeconds = Reflect.get(options as object, "nowSeconds");
    expiresAtSeconds = Reflect.get(options as object, "expiresAtSeconds");
  } catch {
    return false;
  }
  return Number.isSafeInteger(nowSeconds)
    && (nowSeconds as number) >= 0
    && Number.isSafeInteger(expiresAtSeconds)
    && (expiresAtSeconds as number) > (nowSeconds as number);
}

function validD1Result(value: unknown): value is D1Result {
  if (value === null || typeof value !== "object") return false;
  try {
    const meta = Reflect.get(value, "meta");
    const changes = meta !== null && typeof meta === "object"
      ? Reflect.get(meta, "changes")
      : undefined;
    return Reflect.get(value, "success") === true
      && Number.isSafeInteger(changes)
      && (changes as number) >= 0;
  } catch {
    return false;
  }
}

function validD1ClaimBatch(value: unknown): value is readonly [D1Result, D1Result] {
  return Array.isArray(value)
    && value.length === 2
    && validD1Result(value[0])
    && validD1Result(value[1]);
}

/**
 * Adapt the existing nonce table to the provider-neutral release guard port.
 * D1 batches run in order and atomically, so pruning cannot interleave with a
 * competing claim. The primary key plus INSERT OR IGNORE preserves one winner
 * for concurrent requests with the same live nonce.
 */
export function createD1ReleaseNonceStore(
  database: D1ReleaseNonceDatabase,
): ReleaseNonceStore {
  return {
    async consume(
      nonce: string,
      options: ReleaseNonceConsumeOptions,
    ): Promise<"consumed" | "replay"> {
      if (!validWindow(nonce, options)) throw unavailable();

      try {
        const results = await database.batch([
          database.prepare(DELETE_EXPIRED_NONCES).bind(options.nowSeconds),
          database.prepare(INSERT_NONCE).bind(
            nonce,
            options.expiresAtSeconds,
          ),
        ]);
        if (!validD1ClaimBatch(results)) throw unavailable();
        const insertion = results[1];
        const changes = insertion?.meta?.changes;
        if (changes !== 0 && changes !== 1) throw unavailable();
        return changes === 1 ? "consumed" : "replay";
      } catch (error) {
        if (error instanceof ReleaseNonceStorageUnavailableError) throw error;
        throw unavailable();
      }
    },
  };
}

/**
 * Keep D1 binding checks in the Cloudflare composition root. A malformed
 * optional binding disables the route rather than reaching the adapter.
 */
export function configuredD1ReleaseNonceStore(
  value: unknown,
): ReleaseNonceStore | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (typeof Reflect.get(value, "prepare") !== "function"
        || typeof Reflect.get(value, "batch") !== "function") {
      return null;
    }
  } catch {
    return null;
  }
  return createD1ReleaseNonceStore(value as D1ReleaseNonceDatabase);
}
