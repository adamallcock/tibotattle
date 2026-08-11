// The companion relay's session-cookie authority (owner-reported first-sign-in
// mint failure, 2026-08-11).
//
// The dashboard runs inside a macOS WKWebView whose __Host- session cookie
// lives in an out-of-process, now-persistent (v0.1.8) cookie jar. The v1.0
// ceremony enrolls first — the enroll response carries the fresh session
// Set-Cookie — and then, in the same microtask, mints the device pairing. The
// mint's Cookie header is populated from that jar, but the enroll's Set-Cookie
// has not necessarily committed to the disk-backed jar by then, so the mint can
// go out with NO session cookie. The worker answers a cookie-less request with
// AUTH_REQUIRED (session.ts sessionCookieValue: a missing cookie is REQUIRED,
// not INVALID), which is exactly the code observed on the owner's 0.1.8 machine
// across every attempt — the page's bounded 250/500/1000ms mint retry cannot
// close it because the disk commit outran the retry budget.
//
// The page cannot fix this itself: the session cookie is __Host- and HttpOnly,
// so document.cookie can neither read it nor confirm its commit, and the jar
// commit is unobservable from script. The relay is the only component that sees
// the fresh session the instant the enroll returns — it re-emits the upstream
// Set-Cookie toward the jar at that exact point. This bridge captures that fresh
// session in the (single-user, loopback) companion process and forwards it on
// the following relay requests, so the enroll -> mint sequence carries the fresh
// session deterministically, with no dependency on when the WKWebView jar
// commits the cookie.
//
// It never weakens authentication: the captured cookie only ever originates from
// a genuine upstream Set-Cookie the worker issued after a valid enrollment, the
// page can neither read nor inject it, and a server-issued clearing cookie
// (logout, Max-Age=0) drops the capture. When the companion has captured
// nothing — a freshly launched process facing a persistent jar that still holds
// a valid session — the bridge forwards the jar's own cookie unchanged, so the
// owner-approved resume-across-relaunch behaviour is preserved.

const SESSION_COOKIE_NAME = "__Host-usage_monitor_session";

// Relay routes that authenticate with something OTHER than the session cookie —
// the one-use hosted identity proof (enroll, identity start/result), a recovery
// code (recover), or a one-use Upload authorization (contributions). These are
// forwarded with exactly the jar's own cookie and never the captured session:
// /api/v1/contributions in particular carries an Upload authorization with
// credentials omitted, so it must never carry the session secret. Every other
// relay route (session, logout, and the whole /me/* family — including the
// device-pairing mint) authenticates with the session cookie and takes the
// bridge's captured session.
const SESSION_EXEMPT_RELAY_PATHS = Object.freeze(new Set([
  "/api/v1/enroll",
  "/api/v1/identity/google/start",
  "/api/v1/identity/google/result",
  "/api/v1/identity/apple/start",
  "/api/v1/identity/apple/result",
  "/api/v1/recover",
  "/api/v1/contributions",
]));

/**
 * Whether a relay path authenticates with the session cookie (and so may take
 * the bridge's captured session). The exempt routes keep exactly the jar's own
 * cookie forwarding they had before this bridge existed.
 */
export function participantRelayPathUsesSessionCookie(path) {
  return !SESSION_EXEMPT_RELAY_PATHS.has(path);
}

// The single `name=value` session member the jar sends and the relay forwards
// upstream. Mirrors the relay's own participantSessionCookie grammar.
const SESSION_COOKIE_MEMBER =
  /^__Host-usage_monitor_session=[A-Za-z0-9_.-]{0,384}$/u;

// A full upstream Set-Cookie for the session: value plus its attributes. The
// value may be empty and Max-Age may be 0 — that pair is a clearing cookie.
const SESSION_SET_COOKIE =
  /^__Host-usage_monitor_session=(?<value>[A-Za-z0-9_.-]{0,384}); Path=\/; Max-Age=(?<maxAge>[0-9]+); Secure; HttpOnly; SameSite=Strict$/u;

/**
 * Create a per-relay session-cookie bridge. The returned object is stateful for
 * the life of the companion process (one participant at a time on a loopback
 * origin) and must be created once per relay, outside the per-request path.
 */
export function createParticipantSessionCookieBridge() {
  // The freshest `__Host-usage_monitor_session=<token>` member the upstream has
  // issued, or null when nothing live has been captured (never captured, or the
  // server cleared the session). Never holds a clearing cookie.
  let captured = null;

  return Object.freeze({
    /**
     * Learn the session the worker just issued from a relayed upstream
     * Set-Cookie. A live session is captured as the value to forward next; a
     * clearing cookie (empty value or Max-Age=0) drops the capture. Anything
     * that is not the session cookie, or is malformed, is ignored — the relay
     * has already validated the header it re-emits, so this only ever tightens
     * to the session member it recognises.
     */
    observeUpstreamSetCookie(setCookieHeader) {
      if (typeof setCookieHeader !== "string") return;
      const match = SESSION_SET_COOKIE.exec(setCookieHeader);
      if (match?.groups === undefined) return;
      const { value, maxAge } = match.groups;
      if (value === "" || maxAge === "0") {
        captured = null;
        return;
      }
      captured = `${SESSION_COOKIE_NAME}=${value}`;
    },

    /**
     * Choose the session cookie to forward upstream for one relay request.
     * Prefers the captured fresh session when the process holds one — it is
     * always at least as fresh as anything the jar could carry, because every
     * cookie the jar receives arrives through this relay — and otherwise
     * forwards the jar's own cookie so a freshly launched companion still
     * resumes a persisted session.
     *
     * @param {string|null} jarSessionMember the `__Host-usage_monitor_session=…`
     *   member the WKWebView jar sent, or null when it sent none.
     * @returns {string|null} the member to forward, or null to forward none.
     */
    cookieForRequest(jarSessionMember) {
      if (captured !== null) return captured;
      if (typeof jarSessionMember === "string"
          && SESSION_COOKIE_MEMBER.test(jarSessionMember)) {
        return jarSessionMember;
      }
      return null;
    },

    /**
     * Test/inspection helper: the session member currently captured, or null.
     */
    capturedSessionMember() {
      return captured;
    },
  });
}
