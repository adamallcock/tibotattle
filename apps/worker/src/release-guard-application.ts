import { ApiError, errorResponse } from "./errors";
import type { ReleaseObjectStore } from "./release-object-store";
import type { ReleaseNonceStore } from "./release-nonce-store";
import {
  handleConfiguredSparkleAppcastGuard,
  validateReleaseGuardSigningSettings,
} from "./sparkle-appcast-guard";
import type { SparkleAppcastGuardContract } from "./sparkle-appcast-guard";

export interface ReleaseGuardApplicationOptions {
  /** Trusted composition only: the caller chooses the reviewed channel policy. */
  readonly contract: SparkleAppcastGuardContract;
  readonly objects: ReleaseObjectStore;
  /** Must be shared and durable for any deployed service, including test assets. */
  readonly nonces: ReleaseNonceStore;
  readonly signing: {
    readonly token: string;
    readonly publicEdKey: string;
    readonly publicEdKeySha256: string;
  };
  readonly now?: () => number;
}

/** The application integration seam. Supply provider adapters here; neither
 * request input nor ambient environment may select a provider or credentials.
 * This is a release-only HTTP application, not the hosted contribution API.
 */
export function createReleaseGuardApplication(options: ReleaseGuardApplicationOptions): {
  fetch(request: Request): Promise<Response>;
} {
  const signing = validateReleaseGuardSigningSettings(options.signing);
  if (typeof options.objects?.head !== "function"
      || typeof options.objects?.get !== "function"
      || typeof options.objects?.put !== "function"
      || typeof options.nonces?.consume !== "function") {
    throw new ApiError(503, "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID");
  }
  const configuration = Object.freeze({
    enabled: true,
    ...signing,
    bucket: options.objects,
    nonceStore: options.nonces,
  });
  const contract = Object.freeze({
    ...options.contract,
    ...(options.contract.intel === undefined ? {} : {
      intel: Object.freeze({ ...options.contract.intel }),
    }),
  });
  const now = options.now ?? Date.now;
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      try {
        return await handleConfiguredSparkleAppcastGuard(request, configuration, contract, now());
      } catch (error) {
        // Never expose provider messages, request bodies or credentials.
        return errorResponse(
          error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR"),
          crypto.randomUUID(),
        );
      }
    },
  });
}
