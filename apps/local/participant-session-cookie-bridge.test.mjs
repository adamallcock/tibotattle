import assert from "node:assert/strict";
import test from "node:test";

import {
  createParticipantSessionCookieBridge,
  participantRelayPathUsesSessionCookie,
} from "./transport/participant-session-cookie-bridge.js";

const SESSION = "__Host-usage_monitor_session";
const FRESH_TOKEN =
  "um_session_00000000-0000-4000-8000-000000000abc.fresh_secret_value_0000000000000000000000";
const OLDER_TOKEN =
  "um_session_00000000-0000-4000-8000-000000000def.older_secret_value_0000000000000000000000";
const FRESH_MEMBER = `${SESSION}=${FRESH_TOKEN}`;
const OLDER_MEMBER = `${SESSION}=${OLDER_TOKEN}`;

function liveSetCookie(token) {
  return `${SESSION}=${token}; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict`;
}

const CLEARING_SET_COOKIE =
  `${SESSION}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;

test("a fresh companion forwards the jar's own cookie until it captures one", () => {
  const bridge = createParticipantSessionCookieBridge();
  assert.equal(bridge.capturedSessionMember(), null);
  // Resume-across-relaunch: nothing captured yet, so the persistent jar's valid
  // session is what gets forwarded.
  assert.equal(bridge.cookieForRequest(OLDER_MEMBER), OLDER_MEMBER);
  // No jar cookie and nothing captured: forward nothing.
  assert.equal(bridge.cookieForRequest(null), null);
});

test("a captured session is preferred over whatever the jar carries", () => {
  const bridge = createParticipantSessionCookieBridge();
  bridge.observeUpstreamSetCookie(liveSetCookie(FRESH_TOKEN));
  assert.equal(bridge.capturedSessionMember(), FRESH_MEMBER);
  // The enroll->mint window: the jar has not committed the fresh cookie (still
  // null, or still the older one), but the mint carries the captured fresh one.
  assert.equal(bridge.cookieForRequest(null), FRESH_MEMBER);
  assert.equal(bridge.cookieForRequest(OLDER_MEMBER), FRESH_MEMBER);
});

test("a server-issued clearing cookie drops the capture (logout)", () => {
  const bridge = createParticipantSessionCookieBridge();
  bridge.observeUpstreamSetCookie(liveSetCookie(FRESH_TOKEN));
  assert.equal(bridge.capturedSessionMember(), FRESH_MEMBER);
  bridge.observeUpstreamSetCookie(CLEARING_SET_COOKIE);
  assert.equal(bridge.capturedSessionMember(), null);
  // After a clear, the bridge falls back to the jar again.
  assert.equal(bridge.cookieForRequest(OLDER_MEMBER), OLDER_MEMBER);
  assert.equal(bridge.cookieForRequest(null), null);
});

test("the newest captured session wins after a rotation", () => {
  const bridge = createParticipantSessionCookieBridge();
  bridge.observeUpstreamSetCookie(liveSetCookie(OLDER_TOKEN));
  bridge.observeUpstreamSetCookie(liveSetCookie(FRESH_TOKEN));
  assert.equal(bridge.capturedSessionMember(), FRESH_MEMBER);
  assert.equal(bridge.cookieForRequest(OLDER_MEMBER), FRESH_MEMBER);
});

test("non-session and malformed Set-Cookie headers are ignored", () => {
  const bridge = createParticipantSessionCookieBridge();
  bridge.observeUpstreamSetCookie(liveSetCookie(FRESH_TOKEN));
  for (const header of [
    null,
    undefined,
    42,
    "",
    "other_cookie=value; Path=/",
    // A __Host- name but without the required Secure/attributes shape.
    `${SESSION}=${FRESH_TOKEN}`,
    `${SESSION}=${FRESH_TOKEN}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    // An out-of-grammar value character must not be captured.
    `${SESSION}=has spaces; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict`,
  ]) {
    bridge.observeUpstreamSetCookie(header);
    assert.equal(
      bridge.capturedSessionMember(),
      FRESH_MEMBER,
      `ignored: ${String(header)}`,
    );
  }
});

test("a malformed jar cookie is never forwarded when nothing is captured", () => {
  const bridge = createParticipantSessionCookieBridge();
  assert.equal(bridge.cookieForRequest("garbage"), null);
  assert.equal(bridge.cookieForRequest(`${SESSION}=has spaces`), null);
  assert.equal(bridge.cookieForRequest(42), null);
});

test("only retained one-use identity-proof routes are exempt from the captured session", () => {
  // The device-pairing mint and the other retained session-authenticated
  // routes take the captured session.
  for (const path of [
    "/api/v1/session",
    "/api/v1/logout",
    "/api/v1/me/device-pairings",
  ]) {
    assert.equal(participantRelayPathUsesSessionCookie(path), true, path);
  }
  // The retained routes that authenticate with a one-use identity proof keep
  // exactly the jar's own cookie.
  for (const path of [
    "/api/v1/enroll",
    "/api/v1/identity/google/start",
    "/api/v1/identity/google/result",
    "/api/v1/identity/apple/start",
    "/api/v1/identity/apple/result",
  ]) {
    assert.equal(participantRelayPathUsesSessionCookie(path), false, path);
  }
});

test("retired deletion and private owner routes never take the captured session", () => {
  for (const path of ["/api/v1/me", "/api/v1/me/", "/api/v1/admin/action"]) {
    assert.equal(participantRelayPathUsesSessionCookie(path), false, path);
  }
});
