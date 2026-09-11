/**
 * The Electron shell may hand a hosted OAuth authorization request to the
 * user's default browser, but it must never become a generic URL opener. The
 * contribution service currently has exactly these two provider endpoints.
 * Keep this validator small and dependency-free so the main process can run it
 * again after the structured-clone/IPC boundary.
 */
export const HOSTED_SIGNIN_MAX_URL_LENGTH = 4_096;

export const HOSTED_SIGNIN_ENDPOINTS = Object.freeze([
  "https://accounts.google.com/o/oauth2/v2/auth",
  "https://appleid.apple.com/auth/authorize",
]);

const DEFAULT_PORT_ENDPOINTS = Object.freeze([
  "https://accounts.google.com:443/o/oauth2/v2/auth",
  "https://appleid.apple.com:443/auth/authorize",
]);

function invalidHostedSignInUrl() {
  const error = new TypeError("Hosted sign-in authorization URL is invalid");
  error.name = "HostedSignInUrlError";
  error.code = "desktop_hosted_signin_url_invalid";
  return error;
}

/**
 * Validate and return the exact caller-provided authorization URL.
 *
 * The raw endpoint comparison is intentional. WHATWG URL parsing lowercases a
 * hostname and normalizes a default port, which is useful for navigation but
 * would make lookalike/case variants indistinguishable from the allowlist.
 * Parsing is still used for the URL semantics that are difficult to reproduce
 * safely (credentials, port normalization, fragments and malformed escapes).
 * No URL is logged, persisted, or included in an error.
 */
export function validateHostedSignInAuthorizeUrl(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > HOSTED_SIGNIN_MAX_URL_LENGTH
      || value.includes("\\")
      || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) {
    throw invalidHostedSignInUrl();
  }

  const queryStart = value.indexOf("?");
  if (queryStart <= 0 || queryStart === value.length - 1 || value.includes("#")) {
    throw invalidHostedSignInUrl();
  }

  const rawEndpoint = value.slice(0, queryStart);
  const rawQuery = value.slice(queryStart + 1);
  if (/%(?![0-9A-Fa-f]{2})/u.test(rawQuery)) {
    throw invalidHostedSignInUrl();
  }
  const endpointIndex = HOSTED_SIGNIN_ENDPOINTS.indexOf(rawEndpoint);
  const defaultPortIndex = DEFAULT_PORT_ENDPOINTS.indexOf(rawEndpoint);
  if (endpointIndex < 0 && defaultPortIndex < 0) {
    throw invalidHostedSignInUrl();
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidHostedSignInUrl();
  }

  if (parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.port !== ""
      || parsed.hash !== ""
      || parsed.search.length <= 1) {
    throw invalidHostedSignInUrl();
  }

  // The parsed endpoint must agree with the exact raw allowlist entry. This
  // additionally rejects encoded path separators and provider path case
  // changes that happen to survive URL parsing.
  const canonicalEndpoint = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  const expectedEndpoint = endpointIndex >= 0
    ? HOSTED_SIGNIN_ENDPOINTS[endpointIndex]
    : HOSTED_SIGNIN_ENDPOINTS[defaultPortIndex];
  if (canonicalEndpoint !== expectedEndpoint) {
    throw invalidHostedSignInUrl();
  }

  return value;
}

export { invalidHostedSignInUrl };
