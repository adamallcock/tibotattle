import { encodeBase64Url } from "./crypto";
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

export const APPLE_SIGNIN_STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export interface AppleSignInConfiguration {
  readonly servicesId: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeyDer: Uint8Array;
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
): Promise<string> {
  if (typeof code !== "string"
      || code.length === 0
      || code.length > MAXIMUM_AUTHORIZATION_CODE_LENGTH) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const configuration = appleSignInConfiguration(env);
  const clientSecret = await appleClientSecret(env, nowMs);
  let response: Response;
  try {
    response = await fetch(APPLE_TOKEN_URL, {
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
    });
  } catch {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  if (!response.ok) throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  let text: string;
  try {
    text = await response.text();
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
