import assert from "node:assert/strict";
import test from "node:test";

import {
  PARTICIPANT_RELAY_ROUTE_POLICY,
  matchParticipantRelayRoute,
} from "./transport/participant-relay-routes.js";

const EXPECTED_ROUTES = [
  { pathname: "/api/v1/enroll", methods: ["POST"] },
  { pathname: "/api/v1/identity/google/start", methods: ["POST"] },
  { pathname: "/api/v1/identity/google/result", methods: ["POST"] },
  { pathname: "/api/v1/identity/apple/start", methods: ["POST"] },
  { pathname: "/api/v1/identity/apple/result", methods: ["POST"] },
  { pathname: "/api/v1/session", methods: ["GET"] },
  { pathname: "/api/v1/logout", methods: ["POST"] },
  { pathname: "/api/v1/me", methods: ["DELETE"] },
  { pathname: "/api/v1/me/device-pairings", methods: ["POST"] },
];

test("participant relay route policy preserves the exact allowlist", () => {
  assert.equal(EXPECTED_ROUTES.length, 9);
  assert.equal(PARTICIPANT_RELAY_ROUTE_POLICY.length, 9);
  assert.deepEqual(PARTICIPANT_RELAY_ROUTE_POLICY, EXPECTED_ROUTES);
  assert.equal(Object.isFrozen(PARTICIPANT_RELAY_ROUTE_POLICY), true);
  for (const policy of PARTICIPANT_RELAY_ROUTE_POLICY) {
    assert.equal(Object.isFrozen(policy), true, policy.pathname);
    assert.equal(Object.isFrozen(policy.methods), true, policy.pathname);
    assert.equal(matchParticipantRelayRoute(policy.pathname), policy);
  }
});

test("participant relay route policy keeps route matching exact", () => {
  for (const pathname of [
    "/api/v1/admin",
    "/api/v1/enroll/",
    "/api/v1/ENROLL",
    "/api/v1/device-pairings/claim",
    // Neither provider callback is relayed: both are delivered straight to
    // the contribution service over HTTPS.
    "/api/v1/identity/apple/callback",
    "/api/v1/identity/google/callback",
    "/api/v1/identity/google/exchange",
    "/api/v1/device/upload-authorizations",
    "/api/v1/recover",
    "/api/v1/me/stats",
    "/api/v1/me/insights",
    "/api/v1/me/export",
    "/api/v1/me/security-reset",
    "/api/v1/me/upload-authorizations",
    "/api/v1/me/devices",
    "/api/v1/me/devices/revoke",
    "/api/v1/me/contributions/read",
    "/api/v1/me/contributions/delete",
    "/api/v1/contributions",
    "/api/v1/contributions/contribution:private",
    "",
  ]) {
    assert.equal(matchParticipantRelayRoute(pathname), null, pathname);
  }
});
