import { ApiError } from "./errors";
import { configuredR2ReleaseObjectStore } from "./r2-release-object-store";
import { configuredD1ReleaseNonceStore } from "./d1-release-nonce-store";
import stableSparkleReleaseContract from "./sparkle-release-contract.json";
import {
  assertGuardRoute,
  disabledSparkleAppcastGuardConfiguration,
  handleConfiguredSparkleAppcastGuard,
  validateReleaseGuardSigningSettings,
  SPARKLE_APPCAST_GUARD_MAX_XML_BYTES,
  SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV,
  SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV,
} from "./sparkle-appcast-guard";
import type { SparkleAppcastGuardConfiguration, SparkleAppcastGuardContract } from "./sparkle-appcast-guard";

const sparkleReleaseContract: SparkleAppcastGuardContract = stableSparkleReleaseContract;
function setting(env: Env, name: string): unknown { return Reflect.get(env, name); }
function configurationError(): never { throw new ApiError(503, "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID"); }

/** Cloudflare composition: unchanged reviewed binding and channel allowlist. */
export function readSparkleAppcastGuardConfiguration(
  env: Env,
  contract: SparkleAppcastGuardContract = sparkleReleaseContract,
): SparkleAppcastGuardConfiguration {
  const mode = setting(env, "SPARKLE_APPCAST_GUARD_MODE");
  if (mode === undefined || mode === "disabled") {
    return disabledSparkleAppcastGuardConfiguration();
  }
  if (mode !== "enabled") configurationError();

  const expectedSettings: ReadonlyArray<readonly [string, string]> = [
    ["SPARKLE_APPCAST_GUARD_CHANNEL", contract.channel],
    ["SPARKLE_APPCAST_GUARD_BUCKET", contract.r2Bucket],
    ["SPARKLE_APPCAST_GUARD_APPCAST_KEY", contract.appcastObjectKey],
    ["SPARKLE_APPCAST_GUARD_ENDPOINT_PATH", contract.guardRoute],
    ["SPARKLE_APPCAST_GUARD_CONTENT_TYPE", contract.appcastContentType],
    ["SPARKLE_APPCAST_GUARD_CACHE_CONTROL", contract.appcastCacheControl],
    ["SPARKLE_APPCAST_GUARD_MAX_XML_BYTES", String(SPARKLE_APPCAST_GUARD_MAX_XML_BYTES)],
  ];
  for (const [name, expected] of expectedSettings) {
    if (setting(env, name) !== expected) configurationError();
  }
  // A partially bound enabled route must remain indistinguishable from an
  // absent route. The reviewed R2 bucket identity is checked statically by the
  // deployment gate; Workers cannot introspect an R2 binding's bucket name.
  const bucket = configuredR2ReleaseObjectStore(setting(env, "SPARKLE_RELEASES"));
  const nonceStore = configuredD1ReleaseNonceStore(setting(env, "USAGE_MONITOR_DB"));
  if (bucket === null || nonceStore === null) {
    return disabledSparkleAppcastGuardConfiguration();
  }
  const token = setting(env, "SPARKLE_APPCAST_GUARD_TOKEN");
  const publicEdKey = setting(env, SPARKLE_APPCAST_GUARD_PUBLIC_KEY_ENV);
  const publicEdKeySha256 = setting(env, SPARKLE_APPCAST_GUARD_PUBLIC_KEY_SHA256_ENV);
  const signing = validateReleaseGuardSigningSettings({ token, publicEdKey, publicEdKeySha256 });
  return Object.freeze({
    enabled: true,
    token: signing.token,
    bucket,
    nonceStore,
    publicEdKey: signing.publicEdKey,
    publicEdKeySha256: signing.publicEdKeySha256,
  });
}

export async function handleSparkleAppcastGuardForContract(
  request: Request,
  env: Env,
  contract: SparkleAppcastGuardContract,
  nowEpoch = Date.now(),
): Promise<Response> {
  // Preserve route refusal before configuration evaluation.
  assertGuardRoute(request, contract);
  return handleConfiguredSparkleAppcastGuard(
    request, readSparkleAppcastGuardConfiguration(env, contract), contract, nowEpoch,
  );
}

export async function handleSparkleAppcastGuard(
  request: Request,
  env: Env,
  nowEpoch = Date.now(),
): Promise<Response> {
  return handleSparkleAppcastGuardForContract(
    request,
    env,
    sparkleReleaseContract,
    nowEpoch,
  );
}
