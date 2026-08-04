import { encodeBase64Url, randomSecret, sha256Hex } from "./crypto";
import { ApiError } from "./errors";

/**
 * Web Sign in with Apple.
 *
 * The native macOS path is impossible for this product: Sign in with Apple is
 * a restricted entitlement, and Apple's provisioning portal offers it only for
 * Ad hoc, App Store Connect, and Development distribution — never Developer
 * ID. A Developer ID build carrying the entitlement is SIGKILLed at launch.
 * The hosted web flow replaces it entirely.
 *
 * Two things make Apple's web flow different from Google's:
 *
 *  1. The redirect_uri must be HTTPS (loopback is rejected) and Apple returns
 *     the result with response_mode=form_post, so the callback lands on this
 *     Worker rather than on the page that started the flow.
 *  2. client_secret is not a static string. It is an ES256-signed JWT the
 *     service mints per request from the Apple-issued .p8 private key.
 *
 * The Services ID is both the OAuth client_id here and the audience of the
 * id_token Apple returns, so APPLE_SERVICES_ID is the single configured
 * value; identity-oidc.ts verifies the id_token audience against the same
 * variable. Neither the private key nor a minted client secret is ever
 * logged, returned, or included in an error.
 */

const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_CLIENT_SECRET_AUDIENCE = "https://appleid.apple.com";
// Apple allows up to six months. A short life keeps a leaked secret useless.
const CLIENT_SECRET_LIFETIME_SECONDS = 300;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const KEY_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const PKCS8_PEM_PATTERN =
  /-----BEGIN PRIVATE KEY-----([\sA-Za-z0-9+/=]+)-----END PRIVATE KEY-----/u;
const MAXIMUM_SERVICES_ID_LENGTH = 256;
const MAXIMUM_AUTHORIZATION_CODE_LENGTH = 2048;
const MAXIMUM_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_ID_TOKEN_LENGTH = 16 * 1024;
// A browser handoff is short-lived and the callback must resolve to either a
// completed or failed state.  Do not let a provider connection hold that
// state in limbo until the five-minute handoff expires.
export const APPLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 60_000;

export const APPLE_SIGNIN_STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
// Apple receives this value in the authorization request and echoes it in the
// signed ID Token.  Keep the same bounded base64url shape as state; 32 random
// bytes render as 43 characters, comfortably above Apple's minimum.
export const APPLE_SIGNIN_NONCE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
export const APPLE_SIGNIN_NONCE_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface AppleSignInConfiguration {
  readonly servicesId: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeyDer: Uint8Array;
}

export interface AppleAuthorizationCodeExchangeOptions {
  /** Internal test seam; production callers use the bounded default. */
  readonly timeoutMilliseconds?: number;
}

/**
 * Mints the per-authorization nonce used to bind an Apple ID Token to the
 * state row that started the transaction.  Callers must persist only the
 * result of {@link hashAppleSignInNonce}; the raw nonce is request-scoped.
 */
export function generateAppleSignInNonce(): string {
  return randomSecret(32);
}

/**
 * Hashes an Apple authorization nonce for short-lived handoff storage.  The
 * nonce is random and not a bearer credential, but retaining only this fixed
 * digest limits disclosure if a handoff row is inspected or exported.
 */
export async function hashAppleSignInNonce(nonce: string): Promise<string> {
  if (!APPLE_SIGNIN_NONCE_PATTERN.test(nonce)) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  return sha256Hex(nonce);
}

function configurationError(): never {
  throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
}

function decodeBase64(value: string): Uint8Array {
  let raw: string;
  try {
    raw = atob(value);
  } catch {
    configurationError();
  }
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

/**
 * Reads the four Apple values from the environment. Every failure collapses
 * to one fail-closed configuration error that names no value, so a
 * misconfigured deployment can never echo key material back to a caller.
 */
export function appleSignInConfiguration(env: Env): AppleSignInConfiguration {
  const servicesId = Reflect.get(env, "APPLE_SERVICES_ID");
  const teamId = Reflect.get(env, "APPLE_TEAM_ID");
  const keyId = Reflect.get(env, "APPLE_KEY_ID");
  const privateKey = Reflect.get(env, "APPLE_PRIVATE_KEY");
  if (typeof servicesId !== "string"
      || servicesId.length === 0
      || servicesId.length > MAXIMUM_SERVICES_ID_LENGTH
      || typeof teamId !== "string"
      || !TEAM_ID_PATTERN.test(teamId)
      || typeof keyId !== "string"
      || !KEY_ID_PATTERN.test(keyId)
      || typeof privateKey !== "string") {
    configurationError();
  }
  // Secret stores commonly flatten the .p8 newlines to the two characters
  // backslash-n; both spellings describe the same PKCS#8 document.
  const pem = privateKey.replaceAll("\\n", "\n");
  const body = PKCS8_PEM_PATTERN.exec(pem)?.[1];
  if (body === undefined) configurationError();
  const privateKeyDer = decodeBase64(body.replace(/\s+/gu, ""));
  if (privateKeyDer.byteLength === 0) configurationError();
  return Object.freeze({ servicesId, teamId, keyId, privateKeyDer });
}

export function appleAuthorizeUrl(
  configuration: AppleSignInConfiguration,
  redirectUri: string,
  state: string,
  nonce?: string,
): string {
  const parameters = new URLSearchParams({
    client_id: configuration.servicesId,
    redirect_uri: redirectUri,
    response_type: "code",
    // Deliberately empty: no name and no email are ever requested, so Apple
    // has nothing personal to hand over and the service has nothing to drop.
    scope: "",
    response_mode: "form_post",
    state,
  });
  // Keep the optional argument for source compatibility with older callers;
  // production start handlers always supply the freshly generated nonce.  Do
  // not mint one here because the caller would then be unable to persist its
  // corresponding expected digest.
  if (nonce !== undefined) parameters.set("nonce", nonce);
  return `${APPLE_AUTHORIZE_URL}?${parameters.toString()}`;
}

function encodeJwtSegment(value: Record<string, unknown>): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Builds the ES256 client-secret JWT Apple's token endpoint requires:
 * header {alg: ES256, kid}, claims {iss: team, iat, exp, aud, sub: services
 * id}. WebCrypto's ECDSA output is already the raw r||s pair JWS expects, so
 * no DER unwrapping is involved. The returned string is a bearer-grade
 * secret: it is passed straight into the token request and never surfaced.
 */
export async function appleClientSecret(
  env: Env,
  nowMs: number = Date.now(),
): Promise<string> {
  const configuration = appleSignInConfiguration(env);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      configuration.privateKeyDer as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    configurationError();
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const signingInput = `${encodeJwtSegment({
    alg: "ES256",
    kid: configuration.keyId,
    typ: "JWT",
  })}.${encodeJwtSegment({
    iss: configuration.teamId,
    iat: issuedAt,
    exp: issuedAt + CLIENT_SECRET_LIFETIME_SECONDS,
    aud: APPLE_CLIENT_SECRET_AUDIENCE,
    sub: configuration.servicesId,
  })}`;
  let signature: ArrayBuffer;
  try {
    signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput) as unknown as ArrayBuffer,
    );
  } catch {
    configurationError();
  }
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * Exchanges Apple's one-time authorization code for an id_token. Access and
 * refresh tokens in the response are discarded in-request; only the id_token
 * leaves this function, and enrollment remains the sole place that verifies
 * it and derives the stored pairwise link key. Every failure — network,
 * status, body shape — collapses to one opaque token error so nothing about
 * the client secret or Apple's response is reflected to a caller.
 */
export async function exchangeAppleAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
  nowMs: number = Date.now(),
  options: AppleAuthorizationCodeExchangeOptions = {},
): Promise<string> {
  if (typeof code !== "string"
      || code.length === 0
      || code.length > MAXIMUM_AUTHORIZATION_CODE_LENGTH) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const timeoutMilliseconds = options.timeoutMilliseconds
    ?? APPLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1
      || timeoutMilliseconds > MAXIMUM_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const configuration = appleSignInConfiguration(env);
  const clientSecret = await appleClientSecret(env, nowMs);
  let text: string;
  try {
    text = await withAppleProviderTimeout(
      async (signal) => {
        const response = await fetch(APPLE_TOKEN_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: configuration.servicesId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
          signal,
        });
        if (!response.ok) throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
        return response.text();
      },
      timeoutMilliseconds,
    );
  } catch {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  if (text.length > MAXIMUM_TOKEN_RESPONSE_BYTES) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const idToken = Reflect.get(parsed, "id_token");
  if (typeof idToken !== "string"
      || idToken.length === 0
      || idToken.length > MAXIMUM_ID_TOKEN_LENGTH) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return idToken;
}

/**
 * Bounds the complete provider response, not just connection establishment.
 * The abort signal lets a real fetch release its socket/body, while the race
 * also protects the callback when a test or unusual runtime returns a promise
 * that ignores abort.  Neither timeout path includes provider material.
 */
async function withAppleProviderTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Apple identity provider request timed out"));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
