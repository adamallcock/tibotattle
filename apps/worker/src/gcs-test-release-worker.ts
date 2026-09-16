import { ApiError, errorResponse } from "./errors";
import {
  configuredD1ReleaseNonceStore,
} from "./d1-release-nonce-store";
import {
  GcsReleaseObjectStore,
  type GcsFetch,
} from "./gcs-release-object-store";
import { createReleaseGuardApplication } from "./release-guard-application";
import type { SparkleAppcastGuardContract } from "./sparkle-appcast-guard";

/**
 * This module is intentionally a separate local test worker. It has no
 * production entrypoint or production contract fallback, and it refuses
 * non-loopback requests to keep the short-lived-credential lane explicitly
 * local. This host check supplements the local Wrangler listener; it is not
 * a substitute for deployment controls against a deliberately spoofed host.
 */
export const GCS_TEST_BUCKET_PREFIX = "tibotattle-gcs-test-";
export const GCS_TEST_RELEASE_ROUTE = "/__gcs_test__/api/v1/release/appcast";
export const GCS_TEST_RELEASE_SCHEMA = "usage-monitor-gcs-test-release-guard-v1";
export const GCS_TEST_RELEASE_CHANNEL = "gcs-test";
export const GCS_TEST_RELEASE_NAMESPACE_PREFIX = "gcs-test/runs";
export const GCS_TEST_RELEASE_DEFAULT_RUN_ID = "unit";
export const GCS_TEST_RELEASE_RUN_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
export const GCS_TEST_RELEASE_APPCAST_KEY =
  `${GCS_TEST_RELEASE_NAMESPACE_PREFIX}/${GCS_TEST_RELEASE_DEFAULT_RUN_ID}/appcast.xml`;
export const GCS_TEST_RELEASE_OBJECT_PREFIX =
  `${GCS_TEST_RELEASE_NAMESPACE_PREFIX}/${GCS_TEST_RELEASE_DEFAULT_RUN_ID}/releases`;
export const GCS_TEST_RELEASE_UPDATE_ORIGIN = "https://gcs-test-updates.invalid";
export const GCS_TEST_RELEASE_CONTENT_TYPE = "application/xml; charset=utf-8";
export const GCS_TEST_RELEASE_CACHE_CONTROL = "no-store";
export const GCS_TEST_RELEASE_ARTIFACT_CONTENT_TYPE = "application/x-apple-diskimage";
export const GCS_TEST_RELEASE_ARTIFACT_CACHE_CONTROL = "no-store";
export const GCS_TEST_ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 3_600;

function releaseNamespace(runId: string): {
  readonly appcastObjectKey: string;
  readonly objectPrefix: string;
} {
  return {
    appcastObjectKey: `${GCS_TEST_RELEASE_NAMESPACE_PREFIX}/${runId}/appcast.xml`,
    objectPrefix: `${GCS_TEST_RELEASE_NAMESPACE_PREFIX}/${runId}/releases`,
  };
}

/** Stable test-only shape; the checked bucket name is inserted at composition. */
export const GCS_TEST_RELEASE_CONTRACT_SHAPE: Omit<
  SparkleAppcastGuardContract,
  "r2Bucket"
> = Object.freeze({
  architecture: "arm64",
  channel: GCS_TEST_RELEASE_CHANNEL,
  updateOrigin: GCS_TEST_RELEASE_UPDATE_ORIGIN,
  appcastObjectKey: GCS_TEST_RELEASE_APPCAST_KEY,
  objectPrefix: GCS_TEST_RELEASE_OBJECT_PREFIX,
  guardSchema: GCS_TEST_RELEASE_SCHEMA,
  guardRoute: GCS_TEST_RELEASE_ROUTE,
  appcastContentType: GCS_TEST_RELEASE_CONTENT_TYPE,
  appcastCacheControl: GCS_TEST_RELEASE_CACHE_CONTROL,
  artifactContentType: GCS_TEST_RELEASE_ARTIFACT_CONTENT_TYPE,
  artifactCacheControl: GCS_TEST_RELEASE_ARTIFACT_CACHE_CONTROL,
});

export interface GcsTestReleaseWorkerEnv {
  readonly GCS_TEST_BUCKET?: unknown;
  readonly GCS_TEST_RUN_ID?: unknown;
  readonly GCS_ACCESS_TOKEN?: unknown;
  readonly GCS_ACCESS_TOKEN_EXPIRES_AT?: unknown;
  readonly GCS_TEST_RELEASE_TOKEN?: unknown;
  readonly GCS_TEST_PUBLIC_ED_KEY?: unknown;
  readonly GCS_TEST_PUBLIC_ED_KEY_SHA256?: unknown;
  readonly TEST_RELEASE_NONCES?: unknown;
}

export interface GcsTestReleaseWorkerOptions {
  readonly env: GcsTestReleaseWorkerEnv;
  /** Injectable only for local tests; the default uses the Worker fetch. */
  readonly fetchImpl?: GcsFetch;
  /** Epoch milliseconds, injectable for deterministic local tests. */
  readonly now?: () => number;
}

interface GcsTestReleaseConfiguration {
  readonly contract: SparkleAppcastGuardContract;
  readonly bucket: string;
  readonly runId: string;
  readonly accessToken: () => Promise<string>;
  readonly nonces: NonNullable<ReturnType<typeof configuredD1ReleaseNonceStore>>;
  readonly signing: {
    readonly token: string;
    readonly publicEdKey: string;
    readonly publicEdKeySha256: string;
  };
}

function configurationError(): never {
  throw new ApiError(503, "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID");
}

function setting(env: GcsTestReleaseWorkerEnv, name: keyof GcsTestReleaseWorkerEnv): unknown {
  try {
    return Reflect.get(env as object, name);
  } catch {
    configurationError();
  }
}

function localRequestError(): never {
  throw new ApiError(503, "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID");
}

function assertLoopbackRequest(request: Request): void {
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    localRequestError();
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost"
      && hostname !== "[::1]" && hostname !== "::1") {
    localRequestError();
  }
}

function assertApprovedRouteAndMethod(request: Request): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ApiError(404, "NOT_FOUND");
  }
  if (url.pathname !== GCS_TEST_RELEASE_ROUTE || url.search || url.hash) {
    throw new ApiError(404, "NOT_FOUND");
  }
  if (request.method !== "POST") {
    throw new ApiError(405, "METHOD_NOT_ALLOWED", {
      responseHeaders: { allow: "POST" },
    });
  }
}

function testBucket(value: unknown): string {
  if (typeof value !== "string"
      || !value.startsWith(GCS_TEST_BUCKET_PREFIX)
      || value.length < GCS_TEST_BUCKET_PREFIX.length + 1
      || value.length > 63
      || !/^tibotattle-gcs-test-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)) {
    configurationError();
  }
  return value;
}

function testRunId(value: unknown): string {
  if (typeof value !== "string"
      || !GCS_TEST_RELEASE_RUN_ID_PATTERN.test(value)) {
    configurationError();
  }
  return value;
}

function accessToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
      || /[\u0000-\u001f\u007f\s]/u.test(value)) {
    configurationError();
  }
  return value;
}

function expiryEpochSeconds(value: unknown, nowEpoch: number): number {
  if (typeof value !== "string" || !/^\d{1,12}$/u.test(value)
      || !Number.isFinite(nowEpoch) || nowEpoch < 0) {
    configurationError();
  }
  const expiry = Number(value);
  const nowSeconds = Math.floor(nowEpoch / 1000);
  if (!Number.isSafeInteger(expiry)
      || expiry <= nowSeconds
      || expiry - nowSeconds > GCS_TEST_ACCESS_TOKEN_MAX_LIFETIME_SECONDS) {
    configurationError();
  }
  return expiry;
}

function composeConfiguration(
  env: GcsTestReleaseWorkerEnv,
  now: () => number,
): GcsTestReleaseConfiguration {
  const nowEpoch = now();
  if (!Number.isFinite(nowEpoch) || nowEpoch < 0) configurationError();
  const bucket = testBucket(setting(env, "GCS_TEST_BUCKET"));
  const runId = testRunId(setting(env, "GCS_TEST_RUN_ID"));
  const namespace = releaseNamespace(runId);
  accessToken(setting(env, "GCS_ACCESS_TOKEN"));
  expiryEpochSeconds(
    setting(env, "GCS_ACCESS_TOKEN_EXPIRES_AT"),
    nowEpoch,
  );
  const releaseToken = setting(env, "GCS_TEST_RELEASE_TOKEN");
  const publicEdKey = setting(env, "GCS_TEST_PUBLIC_ED_KEY");
  const publicEdKeySha256 = setting(env, "GCS_TEST_PUBLIC_ED_KEY_SHA256");
  const nonces = configuredD1ReleaseNonceStore(setting(env, "TEST_RELEASE_NONCES"));
  if (nonces === null) configurationError();

  const contract: SparkleAppcastGuardContract = Object.freeze({
    ...GCS_TEST_RELEASE_CONTRACT_SHAPE,
    appcastObjectKey: namespace.appcastObjectKey,
    objectPrefix: namespace.objectPrefix,
    r2Bucket: bucket,
  });

  const accessTokenProvider = async (): Promise<string> => {
    // Recheck the short-lived credential at the provider callback, not only
    // during composition, so a request cannot start after expiry.
    const currentToken = accessToken(setting(env, "GCS_ACCESS_TOKEN"));
    expiryEpochSeconds(setting(env, "GCS_ACCESS_TOKEN_EXPIRES_AT"), now());
    return currentToken;
  };

  if (typeof releaseToken !== "string"
      || typeof publicEdKey !== "string"
      || typeof publicEdKeySha256 !== "string") {
    configurationError();
  }

  return {
    contract,
    bucket,
    runId,
    accessToken: accessTokenProvider,
    nonces,
    signing: {
      token: releaseToken,
      publicEdKey,
      publicEdKeySha256,
    },
  };
}

function responseForError(error: unknown): Response {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(503, "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID");
  return errorResponse(apiError, crypto.randomUUID());
}

export function createGcsTestReleaseWorker(
  options: GcsTestReleaseWorkerOptions,
): { fetch(request: Request): Promise<Response> } {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      try {
        assertLoopbackRequest(request);
        assertApprovedRouteAndMethod(request);
        const configuration = composeConfiguration(options.env, now);
        const objects = new GcsReleaseObjectStore(
          configuration.bucket,
          configuration.accessToken,
          options.fetchImpl,
        );
        const application = createReleaseGuardApplication({
          contract: configuration.contract,
          objects,
          nonces: configuration.nonces,
          signing: configuration.signing,
          now,
        });
        return await application.fetch(request);
      } catch (error) {
        return responseForError(error);
      }
    },
  });
}

const worker = {
  fetch(request: Request, env: GcsTestReleaseWorkerEnv): Promise<Response> {
    return createGcsTestReleaseWorker({ env }).fetch(request);
  },
};

export default worker;
