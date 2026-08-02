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
  { pathname: "/api/v1/recover", methods: ["POST"] },
  { pathname: "/api/v1/session", methods: ["GET"] },
  { pathname: "/api/v1/logout", methods: ["POST"] },
  { pathname: "/api/v1/me", methods: ["GET", "DELETE"] },
  { pathname: "/api/v1/me/stats", methods: ["GET"] },
  { pathname: "/api/v1/me/insights", methods: ["GET"] },
  { pathname: "/api/v1/me/export", methods: ["GET"] },
  { pathname: "/api/v1/me/security-reset", methods: ["POST"] },
  { pathname: "/api/v1/me/upload-authorizations", methods: ["POST"] },
  { pathname: "/api/v1/me/device-pairings", methods: ["POST"] },
  { pathname: "/api/v1/me/devices", methods: ["GET"] },
  { pathname: "/api/v1/me/devices/revoke", methods: ["POST"] },
  { pathname: "/api/v1/me/contributions/read", methods: ["POST"] },
  { pathname: "/api/v1/me/contributions/delete", methods: ["POST"] },
  { pathname: "/api/v1/contributions", methods: ["POST"] },
];

test("participant relay route policy preserves the exact allowlist", () => {
  assert.equal(EXPECTED_ROUTES.length, 20);
  assert.equal(PARTICIPANT_RELAY_ROUTE_POLICY.length, 20);
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
    "/api/v1/contributions/contribution:private",
    "",
  ]) {
    assert.equal(matchParticipantRelayRoute(pathname), null, pathname);
  }
});
