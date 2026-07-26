import { sha256, timingSafeEqual } from "./crypto";
import { ENROLLMENT_MODES } from "./constants";
import { ApiError } from "./errors";

export type EnrollmentMode = "local_open" | "invite_only" | "disabled";

export interface ParsedInviteGrant {
  id: string;
  secretHash: Uint8Array;
}

const DEVELOPMENT_ENVIRONMENTS = new Set([
  "synthetic-development",
  "development",
  "local-development",
  "test",
]);

export function isDevelopmentEnvironment(env: Env): boolean {
  const environment = Reflect.get(env, "ENVIRONMENT");
  return typeof environment === "string"
    && DEVELOPMENT_ENVIRONMENTS.has(environment);
}

export function configuredEnrollmentMode(env: Env): EnrollmentMode {
  const mode = Reflect.get(env, "ENROLLMENT_MODE");
  if (typeof mode !== "string"
      || !(ENROLLMENT_MODES as readonly string[]).includes(mode)) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  if (mode === "local_open" && !isDevelopmentEnvironment(env)) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  return mode as EnrollmentMode;
}

export async function assertAttemptAllowed(
  limiter: RateLimit | undefined,
  purpose: "enrollment" | "recovery",
): Promise<void> {
  if (!limiter || typeof limiter.limit !== "function") {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  const result = await limiter.limit({ key: `usage-monitor:${purpose}:global` });
  if (!result.success) throw new ApiError(429, "ATTEMPT_LIMIT_REACHED");
}

export function assertAdmissionBindings(env: Env): void {
  for (const name of ["ENROLLMENT_RATE_LIMIT", "RECOVERY_RATE_LIMIT"] as const) {
    const limiter = Reflect.get(env, name);
    if (!limiter || typeof Reflect.get(limiter, "limit") !== "function") {
      throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
    }
  }
}

export async function hashInviteGrantSecret(id: string, secret: string): Promise<Uint8Array> {
  return sha256(`app-usagemonitor/enrollment-invite/v1\0${id}\0${secret}`);
}

export async function parseInviteGrant(value: unknown): Promise<ParsedInviteGrant> {
  if (typeof value !== "string") throw new ApiError(400, "INVITE_GRANT_INVALID");
  const match = /^um_invite_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u
    .exec(value);
  if (!match?.[1] || !match[2]) throw new ApiError(400, "INVITE_GRANT_INVALID");
  return {
    id: match[1],
    secretHash: await hashInviteGrantSecret(match[1], match[2]),
  };
}

export function inviteGrantHashMatches(
  presented: Uint8Array,
  expected: ArrayBuffer | null,
): boolean {
  return timingSafeEqual(presented, expected ? new Uint8Array(expected) : new Uint8Array(32));
}
