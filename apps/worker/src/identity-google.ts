import { encodeBase64Url, sha256 } from "./crypto";
import { ApiError } from "./errors";

/**
 * Web Google sign-in.
 *
 * This flow is deliberately the same shape as Sign in with Apple: the service
 * owns the redirect target, and the page that started the sign-in reads the
 * result back once, keyed by an unguessable state. The earlier arrangement —
 * a client-side authorization request with a loopback redirect that handed the
 * code back through window.localStorage — could only ever complete in the
 * browser profile that received the redirect. The dashboard now runs inside
 * the macOS app in a WKWebView pinned to the loopback companion, which will
 * not load a provider host and does not share storage with the user's browser,
 * so that completion signal could never arrive. A server-owned redirect plus a
 * polled one-time result completes wherever the dashboard is running.
 *
 * Two properties differ from Apple and are dictated by Google:
 *
 *  1. Google returns the authorization code by ordinary redirect, so the
 *     callback is a GET with query parameters rather than a form post.
 *  2. Google's Web application client type requires client_secret on the token
 *     exchange in addition to the PKCE verifier, so the exchange stays
 *     server-side and the secret never leaves the Worker.
 *
 * PKCE is kept and now belongs entirely to the service: the verifier is minted
 * with the state, stored beside it, and never travels to any client. Scope is
 * fixed to "openid" — no email, name, or profile scope is ever requested — so
 * the id_token carries nothing the service would have to drop before deriving
 * the pairwise link key.
 */

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAXIMUM_CLIENT_ID_LENGTH = 256;
const MAXIMUM_AUTHORIZATION_CODE_LENGTH = 2048;
const MAXIMUM_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_ID_TOKEN_LENGTH = 16 * 1024;

export const GOOGLE_SIGNIN_STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
// RFC 7636's unreserved set. Base64url output is a strict subset of it, so a
// verifier minted with randomSecret always satisfies this.
export const GOOGLE_PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;

export interface GoogleSignInConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
}

function configurationError(): never {
  throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
}

/**
 * Reads the two Google values from the environment. A missing client id and a
 * missing client secret collapse to the same fail-closed error naming neither,
 * so a misconfigured deployment cannot report which value is absent.
 */
export function googleSignInConfiguration(env: Env): GoogleSignInConfiguration {
  const clientId = Reflect.get(env, "GOOGLE_OIDC_CLIENT_ID");
  const clientSecret = Reflect.get(env, "GOOGLE_OIDC_CLIENT_SECRET");
  if (typeof clientId !== "string"
      || clientId.length === 0
      || clientId.length > MAXIMUM_CLIENT_ID_LENGTH
      || typeof clientSecret !== "string"
      || clientSecret.length === 0) {
    configurationError();
  }
  return Object.freeze({ clientId, clientSecret });
}

export async function googleCodeChallenge(codeVerifier: string): Promise<string> {
  return encodeBase64Url(await sha256(codeVerifier));
}

export function googleAuthorizeUrl(
  configuration: GoogleSignInConfiguration,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const parameters = new URLSearchParams({
    client_id: configuration.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    // Nothing beyond a stable subject is requested, so Google has no email or
    // name to hand over and this service has none to drop.
    scope: "openid",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${parameters.toString()}`;
}

/**
 * Exchanges Google's one-time authorization code for an id_token. Access and
 * refresh tokens in the response are discarded in-request; only the id_token
 * leaves this function, and enrollment remains the sole place that verifies it
 * and derives the stored pairwise link key. Every failure — network, status,
 * body shape — collapses to one opaque token error, so neither the client
 * secret nor anything about Google's response is reflected to a caller.
 */
export async function exchangeGoogleAuthorizationCode(
  env: Env,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string> {
  if (typeof code !== "string"
      || code.length === 0
      || code.length > MAXIMUM_AUTHORIZATION_CODE_LENGTH
      || typeof codeVerifier !== "string"
      || !GOOGLE_PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const configuration = googleSignInConfiguration(env);
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code,
        code_verifier: codeVerifier,
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
