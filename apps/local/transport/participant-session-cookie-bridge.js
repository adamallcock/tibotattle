import { randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE_NAME = "__Host-usage_monitor_session";
const SESSION_COOKIE_MEMBER =
  /^__Host-usage_monitor_session=[A-Za-z0-9_.-]{0,384}$/u;
const SESSION_SET_COOKIE =
  /^__Host-usage_monitor_session=(?<value>[A-Za-z0-9_.-]{0,384}); Path=\/; Max-Age=(?<maxAge>[0-9]+); Secure; HttpOnly; SameSite=Strict$/u;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const CONTINUATION_TTL_MS = 30_000;
const MAX_PENDING_CALLERS = 32;

function validToken(value) {
  return typeof value === "string" && OPAQUE_TOKEN.test(value);
}

function sameToken(left, right) {
  return validToken(left) && validToken(right)
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

// The embedded browser's HttpOnly session cookie can commit after enrollment
// finishes. Bridge that single enroll -> pairing race without giving later
// cookie-less requests a process-wide session. The raw session remains here;
// the caller receives only a short-lived, one-use continuation. The local HTTP
// boundary authenticates the caller capability before invoking this bridge.
export function createParticipantSessionCookieBridge({
  now = () => performance.now(),
} = {}) {
  const pending = new Map();

  function expire() {
    const currentTime = now();
    for (const [caller, record] of pending) {
      if (currentTime >= record.expiresAt) pending.delete(caller);
    }
    return currentTime;
  }

  return Object.freeze({
    beginEnrollment(caller) {
      const currentTime = expire();
      if (!validToken(caller)) return null;
      // Starting another ceremony revokes the previous one, including any
      // response that is still in flight. Keep process-local state bounded.
      if (!pending.has(caller) && pending.size >= MAX_PENDING_CALLERS) return null;
      const ceremony = randomBytes(32).toString("base64url");
      pending.set(caller, {
        ceremony,
        continuation: null,
        cookie: null,
        expiresAt: currentTime + CONTINUATION_TTL_MS,
      });
      return ceremony;
    },

    completeEnrollment(caller, ceremony, setCookieHeader) {
      const currentTime = expire();
      const record = pending.get(caller);
      if (!record || !sameToken(ceremony, record.ceremony)) return null;
      // Completing the same ceremony twice cannot mint a replacement token.
      if (record.continuation !== null) return null;
      const match = typeof setCookieHeader === "string"
        ? SESSION_SET_COOKIE.exec(setCookieHeader) : null;
      const maxAge = Number(match?.groups?.maxAge);
      if (!match?.groups?.value || !Number.isSafeInteger(maxAge) || maxAge <= 0) {
        pending.delete(caller);
        return null;
      }
      record.cookie = `${SESSION_COOKIE_NAME}=${match.groups.value}`;
      record.expiresAt = Math.min(record.expiresAt, currentTime + maxAge * 1_000);
      record.continuation = randomBytes(32).toString("base64url");
      return record.continuation;
    },

    cancelEnrollment(caller, ceremony) {
      const record = pending.get(caller);
      if (record && sameToken(ceremony, record.ceremony)) pending.delete(caller);
    },

    clear(caller) {
      pending.delete(caller);
    },

    discardContinuation(caller, continuation) {
      const record = pending.get(caller);
      if (record && sameToken(continuation, record.continuation)) pending.delete(caller);
    },

    observeUpstreamSetCookie(caller, setCookieHeader) {
      const match = typeof setCookieHeader === "string"
        ? SESSION_SET_COOKIE.exec(setCookieHeader) : null;
      if (match?.groups && (!match.groups.value || Number(match.groups.maxAge) === 0)) {
        pending.delete(caller);
      }
    },

    cookieForRequest(jarSessionMember, {
      caller,
      continuation,
      method,
      path,
    } = {}) {
      expire();
      const jarCookie = typeof jarSessionMember === "string"
        && SESSION_COOKIE_MEMBER.test(jarSessionMember) ? jarSessionMember : null;
      const record = pending.get(caller);
      if (!record || !sameToken(continuation, record.continuation)) return jarCookie;

      // Consume before any asynchronous work. A wrong operation, a supplied
      // cookie, or a later upstream failure must not leave a reusable fallback.
      pending.delete(caller);
      if (jarSessionMember !== null && jarSessionMember !== undefined) return jarCookie;
      if (method !== "POST" || path !== "/api/v1/me/device-pairings") return null;
      return record.cookie;
    },
  });
}
