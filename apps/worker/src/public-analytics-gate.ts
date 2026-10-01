import { ApiError } from "./errors";

export interface PublicAnalyticsGateEnv {
  PUBLIC_ANALYTICS_MODE?: unknown;
}

/** Deployment authority is independent of the restored collection-control row.
 * Missing or unknown configuration keeps public analytics unavailable while
 * private projection, erasure, enrollment, and upload processing continue. */
export function publicAnalyticsEnabled(env: PublicAnalyticsGateEnv): boolean {
  return env.PUBLIC_ANALYTICS_MODE === "enabled";
}

export function assertPublicAnalyticsEnabled(
  env: PublicAnalyticsGateEnv,
): void {
  if (!publicAnalyticsEnabled(env)) {
    throw new ApiError(503, "PUBLICATION_DISABLED");
  }
}
