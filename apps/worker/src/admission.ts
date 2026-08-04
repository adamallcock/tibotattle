import { sha256, sha256Hex, timingSafeEqual } from "./crypto";
import { ENROLLMENT_MODES } from "./constants";
import { ApiError } from "./errors";

export type EnrollmentMode = "local_open" | "open" | "invite_only" | "disabled";

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

type AttemptPurpose = "enrollment" | "sign_in_start" | "recovery";
type RateLimitPurpose = AttemptPurpose
  | "public_aggregate_read"
  | "upload_authorization"
  | "upload_ingress";

const RATE_LIMIT_KEY_PREFIX = "app-usagemonitor/rate-limit/v1";
const CLIENT_ADDRESS_PATTERN = /^[0-9a-f:.]{3,45}$/iu;

function assertLimiterConfigured(limiter: RateLimit | undefined): asserts limiter is RateLimit {
  if (!limiter || typeof limiter.limit !== "function") {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
}

function clientAddressForRateLimit(request: Request): string {
  const address = request.headers.get("cf-connecting-ip");
  // This Worker receives CF-Connecting-IP from Cloudflare, where the edge
  // replaces rather than forwards the client-supplied header. Never persist,
  // return, or log the address; malformed/missing values collapse to one
  // availability-safe bucket behind the separate coarse breaker.
  if (address === null || !CLIENT_ADDRESS_PATTERN.test(address)) return "unavailable";
  return address.toLowerCase();
}

async function rateLimitSubjectKey(
  env: Env,
  purpose: RateLimitPurpose,
  subject: string,
): Promise<string> {
  const material = `${RATE_LIMIT_KEY_PREFIX}\0${purpose}\0${subject}`;
  const secret = Reflect.get(env, "IDENTITY_LINK_SECRET");
  if (typeof secret === "string" && secret.length >= 32) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(material),
    );
    return [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  // The offline synthetic environment has no identity secret by design. Its
  // derived key remains non-reversible in logs or Rate Limit keys, while every
  // hosted environment fails closed until its existing identity secret exists.
  if (isDevelopmentEnvironment(env)) return sha256Hex(material);
  throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
}

function clientRateLimitKey(
  request: Request,
  env: Env,
  purpose: RateLimitPurpose,
): Promise<string> {
  return rateLimitSubjectKey(
    env,
    purpose,
    clientAddressForRateLimit(request),
  );
}

function uploadIngressUnavailable(): ApiError {
  return new ApiError(503, "UPLOAD_INGRESS_UNAVAILABLE", {
    responseHeaders: { "retry-after": "60" },
  });
}

async function applyUploadRateLimit(
  limiter: RateLimit,
  key: string,
): Promise<void> {
  let result: { success: boolean };
  try {
    result = await limiter.limit({ key });
  } catch {
    throw uploadIngressUnavailable();
  }
  if (!result.success) {
    throw new ApiError(429, "UPLOAD_INGRESS_LIMIT_REACHED", {
      // Rate Limit does not expose a reset time; all upload bindings use a
      // one-minute window, so clients receive a conservative fixed floor.
      responseHeaders: { "retry-after": "60" },
    });
  }
}

export async function assertAttemptAllowed(
  coarseLimiter: RateLimit | undefined,
  clientLimiter: RateLimit | undefined,
  request: Request,
  env: Env,
  purpose: AttemptPurpose,
): Promise<void> {
  assertLimiterConfigured(coarseLimiter);
  assertLimiterConfigured(clientLimiter);
  const coarse = await coarseLimiter.limit({
    key: `usage-monitor:${purpose}:global`,
  });
  if (!coarse.success) throw new ApiError(429, "ATTEMPT_LIMIT_REACHED");
  const client = await clientLimiter.limit({
    key: `usage-monitor:${purpose}:client:${await clientRateLimitKey(request, env, purpose)}`,
  });
  if (!client.success) throw new ApiError(429, "ATTEMPT_LIMIT_REACHED");
}

export async function assertPublicAggregateReadAllowed(
  limiter: RateLimit | undefined,
  request: Request,
  env: Env,
): Promise<void> {
  assertLimiterConfigured(limiter);
  const result = await limiter.limit({
    key: `usage-monitor:public_aggregate_read:client:${await clientRateLimitKey(
      request,
      env,
      "public_aggregate_read",
    )}`,
  });
  if (!result.success) throw new ApiError(429, "ATTEMPT_LIMIT_REACHED");
}

/**
 * Upload registration is authenticated, so participant-keyed limiting avoids
 * punishing a NAT while a person cannot evade the limit by minting more device
 * credentials. Both keys are HMACed before leaving Worker memory.
 */
export async function assertUploadAuthorizationAllowed(
  coarseLimiter: RateLimit | undefined,
  principalLimiter: RateLimit | undefined,
  principalId: string,
  env: Env,
): Promise<void> {
  assertLimiterConfigured(coarseLimiter);
  assertLimiterConfigured(principalLimiter);
  try {
    const coarse = await coarseLimiter.limit({
      key: "usage-monitor:upload_authorization:global",
    });
    if (!coarse.success) {
      throw new ApiError(429, "UPLOAD_ADMISSION_LIMIT_REACHED", {
        // Cloudflare's binding outcome deliberately does not expose a reset
        // timestamp. This matches the configured one-minute window.
        responseHeaders: { "retry-after": "60" },
      });
    }
    const principal = await principalLimiter.limit({
      key: `usage-monitor:upload_authorization:participant:${await rateLimitSubjectKey(
        env,
        "upload_authorization",
        `participant\0${principalId}`,
      )}`,
    });
    if (principal.success) return;
    throw new ApiError(429, "UPLOAD_ADMISSION_LIMIT_REACHED", {
      responseHeaders: { "retry-after": "60" },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw uploadIngressUnavailable();
  }
}

/**
 * This runs before a contribution body is read. The client key limits one
 * address, while the separately named coarse binding sheds obvious floods
 * before they reach the environment-wide Durable Object.
 */
export async function assertUploadIngressRequestAllowed(
  coarseLimiter: RateLimit | undefined,
  clientLimiter: RateLimit | undefined,
  request: Request,
  env: Env,
): Promise<void> {
  assertLimiterConfigured(coarseLimiter);
  assertLimiterConfigured(clientLimiter);
  await applyUploadRateLimit(
    coarseLimiter,
    "usage-monitor:upload_ingress:global",
  );
  await applyUploadRateLimit(
    clientLimiter,
    `usage-monitor:upload_ingress:client:${await clientRateLimitKey(
      request,
      env,
      "upload_ingress",
    )}`,
  );
}

export function assertUploadAuthorizationBindings(env: Env): void {
  for (const name of [
    "UPLOAD_AUTHORIZATION_RATE_LIMIT",
    "UPLOAD_PRINCIPAL_RATE_LIMIT",
  ] as const) {
    assertLimiterConfigured(Reflect.get(env, name) as RateLimit | undefined);
  }
}

export function assertUploadIngressRateLimitBindings(env: Env): void {
  for (const name of [
    "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
    "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
  ] as const) {
    assertLimiterConfigured(Reflect.get(env, name) as RateLimit | undefined);
  }
}

export function assertAdmissionBindings(env: Env): void {
  for (const name of [
    "ENROLLMENT_RATE_LIMIT",
    "RECOVERY_RATE_LIMIT",
    "CLIENT_ATTEMPT_RATE_LIMIT",
    "PUBLIC_READ_RATE_LIMIT",
  ] as const) {
    assertLimiterConfigured(Reflect.get(env, name) as RateLimit | undefined);
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
