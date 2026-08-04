import * as oauth from "oauth4webapi";

import { sha256Hex } from "./crypto";
import { ApiError, type ErrorCode } from "./errors";
import { isDevelopmentEnvironment } from "./admission";

/**
 * Mandatory hosted identity.
 *
 * Hosted participation (enrollment, and therefore contribution, deletion,
 * and recovery, which are all session-gated) requires a verified OIDC
 * identity from an allowlisted provider. The service never persists the
 * provider subject, email, or name: the only stored value is
 * HMAC-SHA256(IDENTITY_LINK_SECRET, issuer + "\0" + subject) as hex,
 * which is irreversible without the server secret and unique per identity.
 *
 * Development environments keep identity optional so the synthetic local
 * laboratory and the existing lifecycle suites remain runnable offline.
 */

const GOOGLE_ISSUERS = Object.freeze([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const APPLE_ISSUER = "https://appleid.apple.com";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const MAXIMUM_TOKEN_BYTES = 16 * 1024;
const MAXIMUM_JWKS_BYTES = 64 * 1024;
const CLOCK_SKEW_SECONDS = 300;
const MAXIMUM_NONCE_LENGTH = 256;
const NONCE_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface VerifiedIdentity {
  provider: "google" | "apple";
  linkKeyHex: string;
}

interface JsonWebKeySet {
  keys: object[];
}

type JwksFetcher = (url: string) => Promise<JsonWebKeySet>;

interface ProviderServer {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly authorizationServer: oauth.AuthorizationServer;
}

interface OidcServers {
  readonly google: readonly ProviderServer[];
  readonly apple: readonly ProviderServer[];
}

class ProviderUnavailableError extends Error {}

function identityError(code: ErrorCode): never {
  throw new ApiError(401, code);
}

function providerServer(issuer: string, jwksUrl: string): ProviderServer {
  return Object.freeze({
    issuer,
    jwksUrl,
    // Both providers issue RS256 ID Tokens for this integration. Pinning the
    // expected algorithm in the oauth4webapi metadata avoids accepting a
    // future provider-advertised algorithm without an explicit review.
    authorizationServer: Object.freeze({
      issuer,
      jwks_uri: jwksUrl,
      id_token_signing_alg_values_supported: ["RS256"],
    }),
  });
}

function createOidcServers(): OidcServers {
  return Object.freeze({
    // Google documents both issuer spellings. Each is an independently pinned
    // oauth4webapi AuthorizationServer so the library, rather than local JWT
    // parsing, performs the issuer comparison.
    google: Object.freeze(GOOGLE_ISSUERS.map((issuer) => providerServer(issuer, GOOGLE_JWKS_URL))),
    apple: Object.freeze([providerServer(APPLE_ISSUER, APPLE_JWKS_URL)]),
  });
}

// oauth4webapi keeps its JWKS cache against the AuthorizationServer object.
// Replacing these objects is therefore a test-only cache reset without
// recreating a local JWKS cache or reimplementing key selection.
let oidcServers = createOidcServers();

export function clearIdentityJwksCacheForTests(): void {
  oidcServers = createOidcServers();
}

function isJsonWebKeySet(value: unknown): value is JsonWebKeySet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Array.isArray(Reflect.get(value, "keys"));
}

function environmentJwksFetcher(env: Env): JwksFetcher | undefined {
  const testJwksJson = Reflect.get(env, "IDENTITY_TEST_JWKS_JSON");
  if (testJwksJson === undefined) return undefined;
  if (typeof testJwksJson !== "string") {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(testJwksJson);
  } catch {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (!isJsonWebKeySet(parsed)) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  return async () => parsed;
}

async function providerJwksFetcher(
  url: string,
  request: oauth.CustomFetchOptions<"GET">,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      signal: request.signal,
    });
  } catch {
    throw new ProviderUnavailableError();
  }
  if (!response.ok) throw new ProviderUnavailableError();

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderUnavailableError();
  }
  if (text.length > MAXIMUM_JWKS_BYTES) throw new ProviderUnavailableError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderUnavailableError();
  }
  if (!isJsonWebKeySet(parsed)) throw new ProviderUnavailableError();

  // oauth4webapi owns every security-sensitive JWKS operation after this
  // bounded transport read: key filtering, key import, algorithm binding,
  // cache lifetime, and JWS verification.
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function oidcClient(expectedAudience: string, nowMs: number): oauth.Client {
  const actualNowSeconds = Math.floor(Date.now() / 1000);
  const expectedNowSeconds = Math.floor(nowMs / 1000);
  return {
    client_id: expectedAudience,
    id_token_signed_response_alg: "RS256",
    [oauth.clockSkew]: expectedNowSeconds - actualNowSeconds,
    [oauth.clockTolerance]: CLOCK_SKEW_SECONDS,
  };
}

function idTokenResponse(idToken: string): Response {
  // oauth4webapi validates ID Token claims through its OIDC token-response
  // interface. The access token is a fixed, in-memory placeholder only: the
  // actual provider access/refresh tokens were already discarded by the
  // exchange functions, and this response is neither returned nor persisted.
  return Response.json({
    access_token: "oidc-validation-placeholder",
    token_type: "Bearer",
    id_token: idToken,
  });
}

async function validateWithOauth4WebApi(
  server: ProviderServer,
  expectedAudience: string,
  idToken: string,
  nowMs: number,
  jwksFetcher: JwksFetcher | undefined,
  expectedNonce: string | undefined,
): Promise<Record<string, unknown>> {
  const response = idTokenResponse(idToken);
  const tokenResponse = await oauth.processAuthorizationCodeResponse(
    server.authorizationServer,
    oidcClient(expectedAudience, nowMs),
    response,
    {
      // Google keeps the historical no-nonce contract. Apple transactions
      // opt into an exact expected nonce below; requiring that claim rejects
      // a token replayed from a different OIDC transaction.
      expectedNonce: expectedNonce ?? oauth.expectNoNonce,
      requireIdToken: true,
    },
  );

  const signatureOptions: oauth.ValidateSignatureOptions = {
    [oauth.customFetch]: async (url, request) => {
      if (url !== server.jwksUrl) throw new ProviderUnavailableError();
      if (jwksFetcher !== undefined) {
        return Response.json(await jwksFetcher(url));
      }
      return providerJwksFetcher(url, request);
    },
  };
  await oauth.validateApplicationLevelSignature(
    server.authorizationServer,
    response,
    signatureOptions,
  );
  return oauth.getValidatedIdTokenClaims(tokenResponse) as Record<string, unknown>;
}

/**
 * Reads only the unverified nonce claim needed to configure oauth4webapi's
 * claim comparison.  Signature verification still happens immediately after
 * processAuthorizationCodeResponse; this preliminary parse never authorizes
 * an identity and is bound to the persisted digest below.  Keeping this
 * helper local also prevents raw token/nonce material from entering logs.
 */
function unverifiedNonce(idToken: string): string {
  const segments = idToken.split(".");
  if (segments.length !== 3 || segments[1] === undefined) {
    identityError("IDENTITY_TOKEN_INVALID");
  }
  const encoded = segments[1]!.replaceAll("-", "+").replaceAll("_", "/");
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    identityError("IDENTITY_TOKEN_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
  } catch {
    identityError("IDENTITY_TOKEN_INVALID");
  }
  if (typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)) {
    identityError("IDENTITY_TOKEN_INVALID");
  }
  const nonce = Reflect.get(parsed, "nonce");
  if (typeof nonce !== "string"
      || nonce.length === 0
      || nonce.length > MAXIMUM_NONCE_LENGTH) {
    identityError("IDENTITY_TOKEN_INVALID");
  }
  return nonce;
}

export function identityRequired(env: Env): boolean {
  return !isDevelopmentEnvironment(env);
}

export async function verifyHostedIdentity(
  env: Env,
  identity: unknown,
  options: {
    jwksFetcher?: JwksFetcher;
    nowMs?: number;
    /** Raw request-scoped nonce, when a caller deliberately keeps it in memory. */
    expectedNonce?: string;
    /**
     * SHA-256 hex digest of the nonce minted for this Apple transaction. The
     * raw nonce is intentionally not persisted by the handoff repository.
     */
    expectedNonceHash?: string;
  } = {},
): Promise<VerifiedIdentity> {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
    identityError("IDENTITY_REQUIRED");
  }
  const provider = Reflect.get(identity, "provider");
  const idToken = Reflect.get(identity, "idToken");
  const identityKeys = Object.keys(identity);
  if (identityKeys.some((key) => !["provider", "idToken"].includes(key))
      || (provider !== "google" && provider !== "apple")
      || typeof idToken !== "string"
      || idToken.length === 0
      || idToken.length > MAXIMUM_TOKEN_BYTES) {
    identityError("IDENTITY_TOKEN_INVALID");
  }

  // Apple's web flow makes the Services ID both the OAuth client_id and the
  // audience of the id_token it returns, so APPLE_SERVICES_ID is the single
  // configured Apple value; identity-apple.ts reads the same variable when it
  // builds the authorize URL and the ES256 client secret.
  const expectedAudience = provider === "google"
    ? Reflect.get(env, "GOOGLE_OIDC_CLIENT_ID")
    : Reflect.get(env, "APPLE_SERVICES_ID");
  if (typeof expectedAudience !== "string" || expectedAudience.length === 0) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }

  const expectedNonceHash = options.expectedNonceHash;
  const suppliedExpectedNonce = options.expectedNonce;
  if (suppliedExpectedNonce !== undefined
      && (typeof suppliedExpectedNonce !== "string"
        || suppliedExpectedNonce.length === 0
        || suppliedExpectedNonce.length > MAXIMUM_NONCE_LENGTH)) {
    identityError("IDENTITY_TOKEN_INVALID");
  }
  if (expectedNonceHash !== undefined
      && (provider !== "apple" || !NONCE_HASH_PATTERN.test(expectedNonceHash))) {
    identityError("IDENTITY_TOKEN_INVALID");
  }
  if (suppliedExpectedNonce !== undefined && expectedNonceHash !== undefined) {
    const suppliedNonceHash = await sha256Hex(suppliedExpectedNonce);
    if (suppliedNonceHash !== expectedNonceHash) {
      identityError("IDENTITY_TOKEN_INVALID");
    }
  }
  // The only production flow that sends a nonce is Apple.  A missing digest
  // retains the old no-nonce contract for direct callers and Google; the
  // Apple callback integration always supplies the state-row digest.
  const expectedNonce = suppliedExpectedNonce
    ?? (expectedNonceHash === undefined ? undefined : unverifiedNonce(idToken));

  const testJwksFetcher = environmentJwksFetcher(env);
  const jwksFetcher = testJwksFetcher ?? options.jwksFetcher;
  const nowMs = options.nowMs ?? Date.now();
  const servers = provider === "google" ? oidcServers.google : oidcServers.apple;
  let claims: Record<string, unknown> | undefined;
  try {
    for (const server of servers) {
      try {
        claims = await validateWithOauth4WebApi(
          server,
          expectedAudience,
          idToken,
          nowMs,
          jwksFetcher,
          expectedNonce,
        );
        break;
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw error;
      }
    }
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      identityError("IDENTITY_PROVIDER_UNAVAILABLE");
    }
    identityError("IDENTITY_TOKEN_INVALID");
  }
  if (claims === undefined) identityError("IDENTITY_TOKEN_INVALID");

  if (expectedNonceHash !== undefined || suppliedExpectedNonce !== undefined) {
    const nonce = claims.nonce;
    if (typeof nonce !== "string"
        || nonce.length === 0
        || nonce.length > MAXIMUM_NONCE_LENGTH
        || nonce !== expectedNonce) {
      identityError("IDENTITY_TOKEN_INVALID");
    }
    // A raw nonce is already compared exactly above. Hash comparison is only
    // meaningful for the persisted-digest path used by Apple's callback; do
    // not reject an otherwise valid direct caller merely because it supplied
    // the raw expected nonce rather than a storage digest.
    if (expectedNonceHash !== undefined) {
      const actualNonceHash = await sha256Hex(nonce);
      if (actualNonceHash !== expectedNonceHash) {
        identityError("IDENTITY_TOKEN_INVALID");
      }
    }
  }

  const subject = claims.sub;
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 256) {
    identityError("IDENTITY_TOKEN_INVALID");
  }

  const secret = Reflect.get(env, "IDENTITY_LINK_SECRET");
  if (typeof secret !== "string" || secret.length < 32) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonicalIssuer = provider === "google"
    ? "https://accounts.google.com"
    : APPLE_ISSUER;
  const material = new TextEncoder().encode(
    `${canonicalIssuer}\0${subject}`,
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    material as unknown as ArrayBuffer,
  );
  const linkKeyHex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { provider, linkKeyHex };
}
