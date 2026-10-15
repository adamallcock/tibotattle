import assert from "node:assert/strict";
import test from "node:test";

import {
  createParticipantSessionCookieBridge,
} from "./transport/participant-session-cookie-bridge.js";

const SESSION = "__Host-usage_monitor_session";
const FRESH_TOKEN = "synthetic_fresh_session";
const OLDER_TOKEN = "synthetic_persisted_session";
const FRESH_MEMBER = `${SESSION}=${FRESH_TOKEN}`;
const OLDER_MEMBER = `${SESSION}=${OLDER_TOKEN}`;
const CALLER = "C".repeat(43);
const OTHER_CALLER = "D".repeat(43);
const PAIRING = {
  caller: CALLER,
  method: "POST",
  path: "/api/v1/me/device-pairings",
};

function liveSetCookie(token = FRESH_TOKEN, maxAge = 1800) {
  return `${SESSION}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

const CLEARING_SET_COOKIE = liveSetCookie("", 0);

function enroll(bridge, caller = CALLER, setCookie = liveSetCookie()) {
  const ceremony = bridge.beginEnrollment(caller);
  return bridge.completeEnrollment(caller, ceremony, setCookie);
}

test("a fresh or restarted relay resumes only the caller's real jar cookie", () => {
  const first = createParticipantSessionCookieBridge();
  const continuation = enroll(first);
  const restarted = createParticipantSessionCookieBridge();
  for (const bridge of [first, restarted]) {
    assert.equal(bridge.cookieForRequest(OLDER_MEMBER), OLDER_MEMBER);
    assert.equal(bridge.cookieForRequest(null), null);
    assert.equal(bridge.cookieForRequest(null, PAIRING), null);
  }
  assert.equal(restarted.cookieForRequest(null, { ...PAIRING, continuation }), null);
});

test("successful enrollment bridges only one authorized delayed-cookie pairing", () => {
  const bridge = createParticipantSessionCookieBridge();
  const continuation = enroll(bridge);
  assert.match(continuation, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(continuation.includes(FRESH_TOKEN), false);
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), FRESH_MEMBER);
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), null);
  assert.equal(bridge.cookieForRequest(OLDER_MEMBER, PAIRING), OLDER_MEMBER);
});

test("missing, wrong, and malformed caller proof never inherits a session", () => {
  const bridge = createParticipantSessionCookieBridge();
  const continuation = enroll(bridge);
  for (const request of [
    {},
    { ...PAIRING, continuation: undefined },
    { ...PAIRING, continuation: "X".repeat(43) },
    { ...PAIRING, continuation: [continuation] },
    { ...PAIRING, continuation, caller: OTHER_CALLER },
    { ...PAIRING, continuation, caller: undefined },
    { ...PAIRING, continuation, caller: [CALLER] },
  ]) {
    assert.equal(bridge.cookieForRequest(null, request), null);
  }
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), FRESH_MEMBER);
});

test("ordinary, retired, and private relay operations never inherit a session", () => {
  for (const [method, path] of [
    ["GET", "/api/v1/session"],
    ["POST", "/api/v1/logout"],
    ["POST", "/api/v1/enroll"],
    ["POST", "/api/v1/identity/google/start"],
    ["POST", "/api/v1/identity/google/result"],
    ["POST", "/api/v1/identity/apple/start"],
    ["POST", "/api/v1/identity/apple/result"],
    ["POST", "/api/v1/me/device-telemetry-consents"],
    ["POST", "/api/v1/me/device-telemetry-v12-consents"],
    ["POST", "/api/v1/me/device-telemetry-performance-consents"],
    ["GET", "/api/v1/me/device-pairings"],
    ["POST", "/api/v1/me/device-pairings/"],
    ["DELETE", "/api/v1/me"],
    ["POST", "/api/v1/admin/action"],
  ]) {
    const bridge = createParticipantSessionCookieBridge();
    const continuation = enroll(bridge);
    assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation, method, path }), null);
    assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), null,
      "presenting a continuation for the wrong operation consumes it");
  }
});

test("an existing different or malformed jar cookie is never overridden", () => {
  for (const jar of [OLDER_MEMBER, FRESH_MEMBER, `${SESSION}=`, "garbage", 42]) {
    const bridge = createParticipantSessionCookieBridge();
    const continuation = enroll(bridge);
    assert.equal(bridge.cookieForRequest(jar, { ...PAIRING, continuation }),
      typeof jar === "string" && jar.startsWith(`${SESSION}=`) ? jar : null);
    assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), null);
  }
});

test("expiry is bounded by the ceremony deadline and cookie lifetime", () => {
  let now = 100;
  const bridge = createParticipantSessionCookieBridge({ now: () => now });
  const ceremony = bridge.beginEnrollment(CALLER);
  now += 20_000;
  const continuation = bridge.completeEnrollment(CALLER, ceremony, liveSetCookie());
  now += 10_000;
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), null);

  const short = enroll(bridge, CALLER, liveSetCookie(FRESH_TOKEN, 1));
  now += 1_000;
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation: short }), null);

  const stale = bridge.beginEnrollment(CALLER);
  now += 30_000;
  assert.equal(bridge.completeEnrollment(CALLER, stale, liveSetCookie()), null);
});

test("concurrent consumption can return the raw session only once", async () => {
  const bridge = createParticipantSessionCookieBridge();
  const continuation = enroll(bridge);
  const results = await Promise.all(Array.from({ length: 12 }, async () =>
    bridge.cookieForRequest(null, { ...PAIRING, continuation })));
  assert.equal(results.filter((result) => result === FRESH_MEMBER).length, 1);
  assert.equal(results.filter((result) => result === null).length, 11);
});

test("a new ceremony revokes prior tokens and fences late enrollment responses", () => {
  const bridge = createParticipantSessionCookieBridge();
  const oldContinuation = enroll(bridge);
  const supersededCeremony = bridge.beginEnrollment(CALLER);
  const latestCeremony = bridge.beginEnrollment(CALLER);
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation: oldContinuation }), null);
  assert.equal(bridge.completeEnrollment(CALLER, supersededCeremony, liveSetCookie(OLDER_TOKEN)), null);
  bridge.cancelEnrollment(CALLER, supersededCeremony);
  const latestContinuation = bridge.completeEnrollment(CALLER, latestCeremony, liveSetCookie());
  assert.equal(bridge.completeEnrollment(CALLER, latestCeremony, liveSetCookie()), null);
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation: latestContinuation }), FRESH_MEMBER);
});

test("upstream failures, logout, and clearing cookies revoke pending continuation", () => {
  for (const revoke of [
    (bridge, ceremony) => bridge.cancelEnrollment(CALLER, ceremony),
    (bridge) => bridge.clear(CALLER),
    (bridge) => bridge.observeUpstreamSetCookie(CALLER, CLEARING_SET_COOKIE),
    (bridge) => bridge.observeUpstreamSetCookie(CALLER, liveSetCookie(FRESH_TOKEN, "000")),
    (bridge, _ceremony, continuation) => bridge.discardContinuation(CALLER, continuation),
  ]) {
    const bridge = createParticipantSessionCookieBridge();
    const ceremony = bridge.beginEnrollment(CALLER);
    const continuation = bridge.completeEnrollment(CALLER, ceremony, liveSetCookie());
    revoke(bridge, ceremony, continuation);
    assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), null);
    assert.equal(bridge.cookieForRequest(OLDER_MEMBER), OLDER_MEMBER);
  }
});

test("a response cookie alone cannot create fallback authority", () => {
  const bridge = createParticipantSessionCookieBridge();
  bridge.observeUpstreamSetCookie(CALLER, liveSetCookie());
  assert.equal(bridge.cookieForRequest(null, PAIRING), null);
  assert.equal(bridge.completeEnrollment(CALLER, "X".repeat(43), liveSetCookie()), null);
});

test("missing caller and malformed or clearing enrollment cookies cannot mint a continuation", () => {
  const bridge = createParticipantSessionCookieBridge();
  for (const caller of [null, undefined, 42, "", "short", [CALLER]]) {
    assert.equal(bridge.beginEnrollment(caller), null);
  }
  for (const setCookie of [
    null, undefined, 42, "", CLEARING_SET_COOKIE,
    "other_cookie=value; Path=/",
    `${SESSION}=${FRESH_TOKEN}`,
    liveSetCookie("has spaces"),
    liveSetCookie(FRESH_TOKEN, "9007199254740993"),
  ]) {
    const ceremony = bridge.beginEnrollment(CALLER);
    assert.equal(bridge.completeEnrollment(CALLER, ceremony, setCookie), null);
    assert.equal(bridge.cookieForRequest(null, PAIRING), null);
  }
});

test("other callers cannot revoke a ceremony and pending callers are bounded", () => {
  let now = 0;
  const bridge = createParticipantSessionCookieBridge({ now: () => now });
  const continuation = enroll(bridge);
  bridge.clear(OTHER_CALLER);
  bridge.observeUpstreamSetCookie(OTHER_CALLER, CLEARING_SET_COOKIE);
  bridge.discardContinuation(OTHER_CALLER, continuation);
  for (let i = 0; i < 31; i += 1) {
    assert.notEqual(bridge.beginEnrollment(String(i).padStart(43, "A")), null);
  }
  assert.equal(bridge.beginEnrollment(OTHER_CALLER), null);
  assert.equal(bridge.cookieForRequest(null, { ...PAIRING, continuation }), FRESH_MEMBER);
  assert.notEqual(bridge.beginEnrollment(OTHER_CALLER), null);
  now += 30_000;
  assert.notEqual(bridge.beginEnrollment(CALLER), null);
});
