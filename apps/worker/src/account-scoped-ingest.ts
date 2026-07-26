import {
  configuredEnrollmentMode,
  isDevelopmentEnvironment,
} from "./admission";
import { ApiError } from "./errors";

export type AccountScopedIngestMode = "disabled" | "local_preview";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Account-scoped transport is deliberately opt-in and fail-closed. An absent
 * setting means disabled so older and production configurations cannot
 * accidentally activate a newly added collection surface.
 */
export function configuredAccountScopedIngestMode(
  env: Env,
): AccountScopedIngestMode {
  const configured = Reflect.get(env, "ACCOUNT_SCOPED_INGEST_MODE");
  if (configured === undefined || configured === "disabled") return "disabled";
  if (configured !== "local_preview"
      || !isDevelopmentEnvironment(env)
      || configuredEnrollmentMode(env) !== "local_open") {
    throw new ApiError(503, "ACCOUNT_SCOPED_CONFIGURATION_INVALID");
  }
  return configured;
}

export function isLoopbackRequest(request: Request): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(request.url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function assertAccountScopedLocalPreview(
  request: Request,
  env: Env,
): void {
  if (configuredAccountScopedIngestMode(env) !== "local_preview") {
    throw new ApiError(503, "ACCOUNT_SCOPED_INGEST_DISABLED");
  }
  if (!isLoopbackRequest(request)) {
    throw new ApiError(403, "ACCOUNT_SCOPED_LOCAL_ONLY");
  }
}
