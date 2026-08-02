import { describe, expect, it } from "vitest";

import {
  WORKER_ROUTE_POLICY,
  matchWorkerRoute,
} from "../src/route-registry";

const EXACT_ROUTES = [
  [
    "/.well-known/apple-developer-domain-association.txt",
    "apple_domain_association",
  ],
  ["/api/health", "health"],
  ["/api/ready", "ready"],
  ["/api/v1/enroll", "enroll"],
  ["/api/v1/identity/google/start", "identity_google_start"],
  ["/api/v1/identity/google/callback", "identity_google_callback"],
  ["/api/v1/identity/google/result", "identity_google_result"],
  ["/api/v1/identity/apple/start", "identity_apple_start"],
  ["/api/v1/identity/apple/callback", "identity_apple_callback"],
  ["/api/v1/identity/apple/result", "identity_apple_result"],
  ["/api/v1/recover", "recover"],
  ["/api/v1/session", "session"],
  ["/api/v1/logout", "logout"],
  ["/api/v1/admin/overview", "admin_overview"],
  ["/api/v1/admin/action", "admin_action"],
  ["/api/v1/me/security-reset", "security_reset"],
  ["/api/v1/me/upload-authorizations", "upload_authorization"],
  ["/api/v1/me/device-pairings", "device_pairing"],
  ["/api/v1/device-pairings/claim", "device_pairing_claim"],
  ["/api/v1/device/upload-authorizations", "device_upload_authorization"],
  ["/api/v1/me/devices", "participant_devices"],
  ["/api/v1/me/devices/revoke", "participant_device_revocation"],
  ["/api/v1/envelope-key", "envelope_key"],
  ["/api/v1/contributions", "contributions"],
  ["/api/v1/me/contributions/read", "contribution_read"],
  ["/api/v1/me/contributions/delete", "contribution_delete"],
  ["/api/v1/me/export", "participant_export"],
  ["/api/v1/me/stats", "participant_stats"],
  ["/api/v1/me/insights", "participant_stats"],
  ["/api/v1/stats/aggregate", "community_stats"],
  ["/api/v1/community/insights", "community_stats"],
  ["/api/v1/me", "participant"],
] as const;

describe("Worker route registry", () => {
  it("recognizes every exact route and preserves stable log classifications", () => {
    expect(EXACT_ROUTES).toHaveLength(32);
    expect(WORKER_ROUTE_POLICY).toEqual(
      EXACT_ROUTES.map(([pathname, id]) => ({ pathname, id })),
    );
    expect(Object.isFrozen(WORKER_ROUTE_POLICY)).toBe(true);
    for (const definition of WORKER_ROUTE_POLICY) {
      expect(Object.isFrozen(definition)).toBe(true);
    }
    for (const [pathname, id] of EXACT_ROUTES) {
      expect(matchWorkerRoute(pathname), pathname).toEqual({
        kind: "exact",
        id,
        routeClass: id,
      });
    }
  });

  it("maps compatibility aliases to the same logical handlers", () => {
    expect(matchWorkerRoute("/api/v1/me/insights")).toEqual(
      matchWorkerRoute("/api/v1/me/stats"),
    );
    expect(matchWorkerRoute("/api/v1/community/insights")).toEqual(
      matchWorkerRoute("/api/v1/stats/aggregate"),
    );
  });

  it("keeps matching exact and distinguishes unknown APIs from assets", () => {
    for (const pathname of [
      "/api/v1/enroll/",
      "/api/v1/not-a-route",
      "/api/health/",
    ]) {
      expect(matchWorkerRoute(pathname), pathname).toEqual({
        kind: "unknown_api",
        id: "unknown_api",
        routeClass: "unknown_api",
      });
    }

    for (const pathname of [
      "/",
      "/index.html",
      "/api",
      "/apiary",
      // The retired association filename is the only well-known path
      // intercepted by the Worker; all other well-known paths are assets.
      "/.well-known/apple-app-site-association",
      "/.well-known/apple-developer-domain-association.txt/",
    ]) {
      expect(matchWorkerRoute(pathname), pathname).toEqual({
        kind: "asset",
        id: "asset",
        routeClass: "asset",
      });
    }
  });
});
