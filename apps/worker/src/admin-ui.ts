import { ADMIN_UI_ASSETS } from "./admin-ui.generated";

/**
 * Hostname routing policy for the owner-only admin surface.
 *
 * When a hosted environment pins PUBLIC_ORIGIN, the admin surface exists only
 * on `admin.<public host>` and the public website canonicalizes
 * `www.<public host>` to that origin. Development environments configure no
 * PUBLIC_ORIGIN and keep their single-origin behaviour for the offline
 * laboratory and the existing suites.
 */

// The exact admin paths the public origin must keep refusing. This mirrors
// PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS in scripts/production-deploy.mjs,
// which probes them post-deploy on the public origin.
export const ADMIN_SURFACE_PATHS = Object.freeze([
  "/admin",
  "/admin.html",
  "/admin.js",
  "/admin-client.js",
  "/admin.css",
]);

const ADMIN_SURFACE_PATH_SET = new Set<string>(ADMIN_SURFACE_PATHS);

export function isAdminSurfacePath(pathname: string): boolean {
  return ADMIN_SURFACE_PATH_SET.has(pathname);
}

/**
 * The public origin is derived, never request-supplied: it exists only when
 * the environment pins a canonical HTTPS PUBLIC_ORIGIN, exactly as the OAuth
 * callback pinning does. A malformed origin disables hostname-specific
 * behaviour rather than trusting an incoming Host header.
 */
export function canonicalPublicOrigin(env: Env): URL | null {
  const rawOrigin = Reflect.get(env, "PUBLIC_ORIGIN");
  if (typeof rawOrigin !== "string" || rawOrigin.length === 0) return null;
  let configured: URL;
  try {
    configured = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (configured.protocol !== "https:"
      || configured.origin !== rawOrigin
      || configured.hostname.length === 0) {
    return null;
  }
  return configured;
}

/**
 * Redirect only the configured public www alias, retaining the request path
 * and query. The Worker runs before production assets, so this covers both
 * present and future public pages without a separately maintained edge rule.
 */
export function canonicalPublicRedirectUrl(
  requestUrl: URL,
  env: Env,
): string | null {
  const configured = canonicalPublicOrigin(env);
  if (configured === null
      || requestUrl.hostname !== `www.${configured.hostname}`) {
    return null;
  }
  // Assign the path and query as fields rather than parsing them as a relative
  // reference against `configured`: a pathname beginning `//` (or `/\`, which
  // the URL parser folds to `//`) is a network-path reference to the URL
  // constructor and would swap the authority to an attacker origin — an open
  // redirect from the canonical host. The setter keeps the origin fixed, and
  // collapsing a leading slash run means such a value cannot even survive as a
  // confusing same-origin `//…` Location. A network-path prefix never names one
  // of our own pages, so nothing legitimate is lost.
  const target = new URL(configured.href);
  target.pathname = requestUrl.pathname.replace(/^[/\\]+/, "/");
  target.search = requestUrl.search;
  return target.href;
}

/**
 * The admin hostname is derived from the same pinned canonical public origin.
 * A malformed origin yields no admin hostname, which keeps every admin path
 * on its existing refusal.
 */
export function adminHostname(env: Env): string | null {
  const configured = canonicalPublicOrigin(env);
  return configured === null ? null : `admin.${configured.hostname}`;
}

function adminUiAssetPath(pathname: string): string | null {
  // Exactly the admin surface paths and nothing else. In production the
  // shared asset layer answers other paths on this hostname before the
  // Worker runs, so mapping extra aliases here would only create behaviour
  // that exists in tests and never at the edge.
  if (pathname === "/admin") return "/admin.html";
  return Object.hasOwn(ADMIN_UI_ASSETS, pathname) ? pathname : null;
}

/**
 * Serves the embedded admin UI on the admin hostname. Only GET/HEAD are
 * meaningful for static assets; other methods fall through to the API router
 * so its own refusals stay authoritative.
 */
export function adminUiResponse(
  method: string,
  pathname: string,
): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const assetPath = adminUiAssetPath(pathname);
  if (assetPath === null) return null;
  const asset = ADMIN_UI_ASSETS[assetPath];
  if (!asset) return null;
  const headers = new Headers({
    "content-type": asset.contentType,
    // The admin surface is authenticated and owner-only; nothing about it
    // may enter a shared or persistent cache.
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "content-security-policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
  return new Response(method === "HEAD" ? null : asset.content, {
    status: 200,
    headers,
  });
}
