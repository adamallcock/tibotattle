function defineParticipantRelayRoute(pathname, methods) {
  return Object.freeze({
    pathname,
    methods: Object.freeze(methods),
  });
}

export const PARTICIPANT_RELAY_ROUTE_POLICY = Object.freeze([
  defineParticipantRelayRoute("/api/v1/enroll", ["POST"]),
  // Hosted sign-in, both providers. Only the start and result calls cross this
  // relay: each provider's callback is delivered straight to the contribution
  // service over HTTPS and never reaches the loopback companion.
  defineParticipantRelayRoute("/api/v1/identity/google/start", ["POST"]),
  defineParticipantRelayRoute("/api/v1/identity/google/result", ["POST"]),
  defineParticipantRelayRoute("/api/v1/identity/apple/start", ["POST"]),
  defineParticipantRelayRoute("/api/v1/identity/apple/result", ["POST"]),
  defineParticipantRelayRoute("/api/v1/session", ["GET"]),
  defineParticipantRelayRoute("/api/v1/logout", ["POST"]),
  defineParticipantRelayRoute("/api/v1/me", ["DELETE"]),
  defineParticipantRelayRoute("/api/v1/me/device-pairings", ["POST"]),
]);

const PARTICIPANT_RELAY_ROUTES = new Map();
for (const policy of PARTICIPANT_RELAY_ROUTE_POLICY) {
  if (PARTICIPANT_RELAY_ROUTES.has(policy.pathname)) {
    throw new Error("Duplicate participant relay route");
  }
  PARTICIPANT_RELAY_ROUTES.set(policy.pathname, policy);
}

export function matchParticipantRelayRoute(pathname) {
  return PARTICIPANT_RELAY_ROUTES.get(pathname) ?? null;
}
