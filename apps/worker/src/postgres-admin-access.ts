/**
 * The admin-host chokepoint for the PostgreSQL origin (GCP, C-ADMIN).
 *
 * This is the Worker's admin-hostname authorization at d43c8f92
 * (index.ts handleRequest, admin hostname branch), composed from the Worker's
 * own unmodified functions:
 *
 * 1. verifyAdminAccessAssertion: the Cloudflare Access application token from
 *    the Cf-Access-Jwt-Assertion header, or the CF_Authorization cookie, is
 *    verified against the Access team's published RS256 keys, issuer,
 *    audience and validity window (403 ACCESS_REQUIRED; 503
 *    ADMIN_NOT_CONFIGURED when ACCESS_TEAM_DOMAIN or ACCESS_AUD is absent or
 *    malformed);
 * 2. authorizeAdminEmail: the verified email must equal ACCESS_ADMIN_EMAIL
 *    after the shared normalization (403 ADMIN_REQUIRED; 503
 *    ADMIN_NOT_CONFIGURED when the pin is absent or malformed).
 *
 * The result is the normalized owner email: the identity key the composition
 * root registers as the request context's adminIdentityKey (FC-4) and the
 * seed of the admin audit actor digest. Route families never re-verify; they
 * read the registered key and refuse without it.
 *
 * The CSRF check of POST /api/v1/admin/action is not here: the Worker runs it
 * inside the action handler (session.ts assertAdminCsrf), and so does the
 * ported family.
 *
 * One addition, fail-closed: the Worker's ACCESS_TEST_JWKS_JSON seam replaces
 * the Access key fetch with keys taken from the environment. A production
 * origin must never honour it, so construction refuses an env that carries
 * it unless the caller explicitly opts into a test origin. CR-3's production
 * configuration already refuses the variable (ACCESS_TEST_JWKS_JSON_FORBIDDEN);
 * this is defense in depth at the point of use.
 */
import { authorizeAdminEmail, verifyAdminAccessAssertion } from "./admin-access";

/** The Worker env keys the chokepoint reads. A frozen origin env must carry them. */
export const POSTGRES_ADMIN_ACCESS_ENV_KEYS = Object.freeze([
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "ACCESS_ADMIN_EMAIL",
] as const);

/** The Worker's offline key seam; refused unless a test origin opts in. */
export const POSTGRES_ADMIN_ACCESS_TEST_JWKS_KEY = "ACCESS_TEST_JWKS_JSON";

export const POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID =
  "POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID";
export const POSTGRES_ADMIN_ACCESS_TEST_JWKS_FORBIDDEN =
  "POSTGRES_ADMIN_ACCESS_TEST_JWKS_FORBIDDEN";

export interface PostgresAdminAccessOptions {
  /**
   * Accept ACCESS_TEST_JWKS_JSON in env. Only a loopback test origin may set
   * this; production and staging composition roots never do.
   */
  readonly allowTestJwks?: boolean;
  /** Test seam for the token validity window; defaults to Date.now. */
  readonly clock?: () => number;
}

/** Verify Access and the owner pin; resolves the normalized owner email. */
export type PostgresAdminAccessChokepoint = (request: Request) => Promise<string>;

function configurationError(code: string): TypeError {
  return Object.assign(new TypeError(code), { code });
}

/**
 * Build the chokepoint over a frozen Worker-shaped env (an explicit allowlist
 * read with Reflect.get, never process.env). The env is captured once; the
 * Access configuration inside it is validated per request exactly as the
 * Worker validates it, so a missing value answers 503 ADMIN_NOT_CONFIGURED
 * rather than failing construction.
 */
export function createPostgresAdminAccessChokepoint(
  env: unknown,
  options: PostgresAdminAccessOptions = {},
): PostgresAdminAccessChokepoint {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw configurationError(POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID);
  }
  if (options === null || typeof options !== "object") {
    throw configurationError(POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID);
  }
  const allowTestJwks = options.allowTestJwks ?? false;
  if (typeof allowTestJwks !== "boolean") {
    throw configurationError(POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID);
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") {
    throw configurationError(POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID);
  }
  if (!allowTestJwks && Reflect.get(env, POSTGRES_ADMIN_ACCESS_TEST_JWKS_KEY) !== undefined) {
    throw configurationError(POSTGRES_ADMIN_ACCESS_TEST_JWKS_FORBIDDEN);
  }
  const workerEnv = env as Env;
  return async function postgresAdminAccessChokepoint(request: Request): Promise<string> {
    const identity = await verifyAdminAccessAssertion(request, workerEnv, { nowMs: clock() });
    return authorizeAdminEmail(identity, Reflect.get(workerEnv, "ACCESS_ADMIN_EMAIL"));
  };
}
