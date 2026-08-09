import { ApiError } from "./errors";

/**
 * Cloudflare Access enforcement for the owner-only admin hostname.
 *
 * The admin surface is served exclusively on `admin.<public host>` behind a
 * Cloudflare Access (Zero Trust) application whose identity provider and
 * allow-policy live in the Cloudflare dashboard — no OAuth code here. This
 * module is the Worker-side defense in depth: every admin-host request must
 * carry the `Cf-Access-Jwt-Assertion` header Access injects after login, and
 * that JWT is verified against the Access team's published signing keys
 * (standard JWKS fetch with bounded caching). Absent or invalid tokens are
 * rejected with 403; absent or malformed configuration fails closed with the
 * same ADMIN_NOT_CONFIGURED refusal the rest of the admin surface uses.
 */

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

// An Access team domain is always `<team>.cloudflareaccess.com`. Anything
// else — including an empty placeholder — is unconfigured, never a fetch.
const ACCESS_TEAM_DOMAIN_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/u;
// Access application audience (AUD) tags are 64 lowercase hex characters.
const ACCESS_AUD_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_TOKEN_BYTES = 8 * 1024;
const MAXIMUM_JWKS_BYTES = 64 * 1024;
const CLOCK_SKEW_SECONDS = 300;
const JWKS_CACHE_MILLISECONDS = 10 * 60 * 1000;
// A verification miss on an unknown key id refetches at most this often, so a
// forged-kid flood cannot turn the Worker into a JWKS request amplifier.
const JWKS_REFETCH_FLOOR_MILLISECONDS = 60 * 1000;
const JWKS_REQUEST_TIMEOUT_MILLISECONDS = 10_000;

export interface AdminAccessConfiguration {
  readonly teamDomain: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audience: string;
}

interface JsonWebKeySet {
  keys: object[];
}

type JwksFetcher = () => Promise<JsonWebKeySet>;

interface CachedJwks {
  jwksUrl: string;
  fetchedAtEpoch: number;
  keys: Map<string, CryptoKey>;
}

let cachedJwks: CachedJwks | null = null;

export function clearAdminAccessJwksCacheForTests(): void {
  cachedJwks = null;
}

function accessDenied(): never {
  throw new ApiError(403, "ACCESS_REQUIRED");
}

function notConfigured(): never {
  throw new ApiError(503, "ADMIN_NOT_CONFIGURED");
}

/**
 * Reads the Access application binding for this environment. Placeholders and
 * malformed values yield `null`; callers on the admin hostname must then fail
 * closed rather than serving the admin surface unauthenticated.
 */
export function adminAccessConfiguration(
  env: Env,
): AdminAccessConfiguration | null {
  const teamDomain = Reflect.get(env, "ACCESS_TEAM_DOMAIN");
  const audience = Reflect.get(env, "ACCESS_AUD");
  if (typeof teamDomain !== "string"
      || !ACCESS_TEAM_DOMAIN_PATTERN.test(teamDomain)
      || typeof audience !== "string"
      || !ACCESS_AUD_PATTERN.test(audience)) {
    return null;
  }
  return Object.freeze({
    teamDomain,
    issuer: `https://${teamDomain}`,
    jwksUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
    audience,
  });
}

function isJsonWebKeySet(value: unknown): value is JsonWebKeySet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Array.isArray(Reflect.get(value, "keys"));
}

/**
 * Test seam mirroring IDENTITY_TEST_JWKS_JSON: a JWKS supplied through the
 * environment replaces the network fetch so specs can exercise the complete
 * verification path offline. A present-but-malformed value fails closed.
 */
function environmentJwksFetcher(env: Env): JwksFetcher | undefined {
  const testJwksJson = Reflect.get(env, "ACCESS_TEST_JWKS_JSON");
  if (testJwksJson === undefined) return undefined;
  if (typeof testJwksJson !== "string") notConfigured();
  let parsed: unknown;
  try {
    parsed = JSON.parse(testJwksJson);
  } catch {
    notConfigured();
  }
  if (!isJsonWebKeySet(parsed)) notConfigured();
  return async () => parsed;
}

async function fetchAccessJwks(jwksUrl: string): Promise<JsonWebKeySet> {
  let response: Response;
  try {
    response = await fetch(jwksUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(JWKS_REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    accessDenied();
  }
  if (!response.ok) accessDenied();
  let text: string;
  try {
    text = await response.text();
  } catch {
    accessDenied();
  }
  if (text.length > MAXIMUM_JWKS_BYTES) accessDenied();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    accessDenied();
  }
  if (!isJsonWebKeySet(parsed)) accessDenied();
  return parsed;
}

async function importVerificationKeys(
  jwks: JsonWebKeySet,
): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  for (const candidate of jwks.keys) {
    const kid = Reflect.get(candidate, "kid");
    const kty = Reflect.get(candidate, "kty");
    const alg = Reflect.get(candidate, "alg");
    if (typeof kid !== "string" || kid.length === 0 || kid.length > 256) {
      continue;
    }
    if (kty !== "RSA" || (alg !== undefined && alg !== "RS256")) continue;
    try {
      keys.set(kid, await crypto.subtle.importKey(
        "jwk",
        candidate as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ));
    } catch {
      // A single unusable published key must not take verification down for
      // the keys that do import; an empty set still fails closed below.
    }
  }
  return keys;
}

async function verificationKey(
  configuration: AdminAccessConfiguration,
  kid: string,
  nowMs: number,
  jwksFetcher: JwksFetcher | undefined,
): Promise<CryptoKey> {
  if (jwksFetcher !== undefined) {
    const keys = await importVerificationKeys(await jwksFetcher());
    const key = keys.get(kid);
    if (!key) accessDenied();
    return key;
  }
  const cacheValid = cachedJwks !== null
    && cachedJwks.jwksUrl === configuration.jwksUrl
    && nowMs - cachedJwks.fetchedAtEpoch <= JWKS_CACHE_MILLISECONDS
    && nowMs >= cachedJwks.fetchedAtEpoch;
  if (cacheValid) {
    const cachedKey = cachedJwks!.keys.get(kid);
    if (cachedKey) return cachedKey;
    // Unknown kid with a recent fetch: refuse instead of refetching so a
    // stream of forged key ids cannot bypass the cache lifetime.
    if (nowMs - cachedJwks!.fetchedAtEpoch < JWKS_REFETCH_FLOOR_MILLISECONDS) {
      accessDenied();
    }
  }
  const keys = await importVerificationKeys(
    await fetchAccessJwks(configuration.jwksUrl),
  );
  cachedJwks = {
    jwksUrl: configuration.jwksUrl,
    fetchedAtEpoch: nowMs,
    keys,
  };
  const key = keys.get(kid);
  if (!key) accessDenied();
  return key;
}

function decodeBase64UrlSegment(segment: string): Uint8Array {
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(segment)) {
    accessDenied();
  }
  const encoded = segment.replaceAll("-", "+").replaceAll("_", "/");
  let decoded: string;
  try {
    decoded = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
  } catch {
    accessDenied();
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
        .decode(decodeBase64UrlSegment(segment)),
    );
  } catch {
    accessDenied();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    accessDenied();
  }
  return parsed as Record<string, unknown>;
}

function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === "string") return claim === expected;
  return Array.isArray(claim)
    && claim.some((entry) => typeof entry === "string" && entry === expected);
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header on an admin-host request.
 * Missing configuration is 503 ADMIN_NOT_CONFIGURED; every token problem —
 * absent header, malformed JWT, unknown key, bad signature, wrong issuer or
 * audience, or an expired/premature validity window — is 403 ACCESS_REQUIRED
 * with no detail about which check refused.
 */
export async function verifyAdminAccessAssertion(
  request: Request,
  env: Env,
  options: { nowMs?: number } = {},
): Promise<void> {
  const configuration = adminAccessConfiguration(env);
  if (configuration === null) notConfigured();
  const jwksFetcher = environmentJwksFetcher(env);
  const nowMs = options.nowMs ?? Date.now();

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null
      || token.length === 0
      || token.length > MAXIMUM_TOKEN_BYTES) {
    accessDenied();
  }
  const segments = token.split(".");
  if (segments.length !== 3
      || segments[0] === undefined
      || segments[1] === undefined
      || segments[2] === undefined) {
    accessDenied();
  }
  const header = decodeJsonSegment(segments[0]);
  if (header.alg !== "RS256") accessDenied();
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 256) {
    accessDenied();
  }

  const key = await verificationKey(configuration, kid, nowMs, jwksFetcher);
  const signedInput = new TextEncoder().encode(
    `${segments[0]}.${segments[1]}`,
  );
  let signatureValid: boolean;
  try {
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64UrlSegment(segments[2]) as unknown as ArrayBuffer,
      signedInput as unknown as ArrayBuffer,
    );
  } catch {
    accessDenied();
  }
  if (!signatureValid) accessDenied();

  const claims = decodeJsonSegment(segments[1]);
  const nowSeconds = Math.floor(nowMs / 1000);
  const expiry = claims.exp;
  if (claims.iss !== configuration.issuer
      || !audienceMatches(claims.aud, configuration.audience)
      || typeof expiry !== "number"
      || !Number.isFinite(expiry)
      || nowSeconds > expiry + CLOCK_SKEW_SECONDS) {
    accessDenied();
  }
  const notBefore = claims.nbf;
  if (notBefore !== undefined
      && (typeof notBefore !== "number"
        || !Number.isFinite(notBefore)
        || nowSeconds < notBefore - CLOCK_SKEW_SECONDS)) {
    accessDenied();
  }
  const issuedAt = claims.iat;
  if (issuedAt !== undefined
      && (typeof issuedAt !== "number"
        || !Number.isFinite(issuedAt)
        || nowSeconds < issuedAt - CLOCK_SKEW_SECONDS)) {
    accessDenied();
  }
}
