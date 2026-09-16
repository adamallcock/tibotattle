/**
 * Provider-neutral replay nonce contract for the release guard.
 *
 * The caller supplies both sides of the accepted retention window. Keeping
 * the clock and policy outside this interface makes a future adapter unable
 * to silently choose a different clock, TTL, or boundary than the guard.
 */
export interface ReleaseNonceConsumeOptions {
  /** Current epoch time, in whole seconds. */
  readonly nowSeconds: number;
  /** Exact expiry to persist for a newly consumed nonce, in whole seconds. */
  readonly expiresAtSeconds: number;
}

/**
 * `replay` means a non-expired row for this nonce already won the race. The
 * guard maps that result to its existing 401 replay code; it is not a storage
 * outage.
 */
export type ReleaseNonceConsumeResult = "consumed" | "replay";

export interface ReleaseNonceStore {
  /**
   * Atomically claim `nonce` with `expiresAtSeconds` when absent or expired
   * at `nowSeconds`. An expired record must not block the claim even if a
   * provider's background TTL cleanup has not physically removed it yet.
   * Implementations own cleanup of other expired records; the policy requires
   * the exact `<=` eligibility boundary, not a global scan on every request.
   * Never retry a failed claim as an unconditional write.
   */
  consume(
    nonce: string,
    options: ReleaseNonceConsumeOptions,
  ): Promise<ReleaseNonceConsumeResult>;
}

/** Provider failures are deliberately content-free at this boundary. */
export class ReleaseNonceStorageUnavailableError extends Error {
  constructor() {
    super("RELEASE_NONCE_STORAGE_UNAVAILABLE");
    this.name = "ReleaseNonceStorageUnavailableError";
  }
}
