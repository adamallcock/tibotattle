import { describe, expect, it } from "vitest";

import {
  WORKER_ROUTE_POLICY,
  matchWorkerRoute,
} from "../src/route-registry";
import type { WorkerRouteDefinition } from "../src/route-registry";
import { handleRequest } from "../src/index";

const EXACT_ROUTES = [
  {
    pathname: "/.well-known/apple-developer-domain-association.txt",
    id: "apple_domain_association",
    methods: "all",
    authority: "none",
  },
  {
    pathname: "/api/health",
    id: "health",
    methods: ["GET"],
    authority: "public",
  },
  {
    pathname: "/api/ready",
    id: "ready",
    methods: ["GET"],
    authority: "public",
  },
  {
    pathname: "/api/v1/enroll",
    id: "enroll",
    methods: ["POST"],
    authority: "enrollment",
  },
  {
    pathname: "/api/v1/internal/release/appcast",
    id: "sparkle_appcast_guard",
    methods: ["POST"],
    authority: "operator",
  },
  {
    pathname: "/api/v1/identity/google/start",
    id: "identity_google_start",
    methods: ["POST"],
    authority: "handoff",
  },
  {
    pathname: "/api/v1/identity/google/callback",
    id: "identity_google_callback",
    methods: ["GET"],
    authority: "handoff",
  },
  {
    pathname: "/api/v1/identity/google/result",
    id: "identity_google_result",
    methods: ["POST"],
    authority: "handoff",
  },
  {
    pathname: "/api/v1/identity/apple/start",
    id: "identity_apple_start",
    methods: ["POST"],
    authority: "handoff",
  },
  {
    pathname: "/api/v1/identity/apple/callback",
    id: "identity_apple_callback",
    methods: ["POST"],
    authority: "handoff",
  },
  {
    pathname: "/api/v1/identity/apple/result",
    id: "identity_apple_result",
    methods: ["POST"],
    authority: "handoff",
  },
  {
    pathname: "/api/v1/session",
    id: "session",
    methods: ["GET"],
    authority: "session",
  },
  {
    pathname: "/api/v1/logout",
    id: "logout",
    methods: ["POST"],
    authority: "session",
  },
  {
    pathname: "/api/v1/admin/overview",
    id: "admin_overview",
    methods: ["GET"],
    authority: "admin",
  },
  {
    pathname: "/api/v1/admin/metrics/history",
    id: "admin_metrics_history",
    methods: ["GET"],
    authority: "admin",
  },
  {
    pathname: "/api/v1/admin/community/allowance-preview",
    id: "admin_community_allowance_preview",
    methods: ["GET"],
    authority: "admin",
  },
  {
    pathname: "/api/v1/admin/action",
    id: "admin_action",
    methods: ["POST"],
    authority: "admin",
  },
  {
    pathname: "/api/v1/me/security-reset",
    id: "security_reset",
    methods: ["POST"],
    authority: "session",
  },
  {
    pathname: "/api/v1/me/device-pairings",
    id: "device_pairing",
    methods: ["POST"],
    authority: "session",
  },
  {
    pathname: "/api/v1/device-pairings/claim",
    id: "device_pairing_claim",
    methods: ["POST"],
    authority: "pairing_code",
  },
  {
    pathname: "/api/v1/device/upload-authorizations",
    id: "device_upload_authorization",
    methods: ["POST"],
    authority: "device",
  },
  {
    pathname: "/api/v1/device/disconnect",
    id: "device_disconnect",
    methods: ["POST"],
    authority: "device",
  },
  {
    pathname: "/api/v1/device/credential/renew",
    id: "device_credential_renew",
    methods: ["POST"],
    authority: "device",
  },
  {
    pathname: "/api/v1/device/sync/state",
    id: "device_sync_state",
    methods: ["GET"],
    authority: "device",
  },
  {
    pathname: "/api/v1/device/sync-capabilities",
    id: "device_sync_capabilities",
    methods: ["GET"],
    authority: "device",
  },
  {
    pathname: "/api/v1/me/device-telemetry-consents",
    id: "telemetry_v11_consent",
    methods: ["POST"],
    authority: "session",
  },
  {
    pathname: "/api/v1/device/telemetry/v1.1/day-manifests",
    id: "telemetry_v11_day_manifests",
    methods: ["GET", "POST"],
    authority: "device",
  },
  {
    pathname: "/api/v1/me/telemetry-v11/domain-predecessor",
    id: "telemetry_v11_domain_predecessor",
    methods: ["POST"],
    authority: "device",
  },
  {
    pathname: "/api/v1/me/telemetry-v11/domain-activate",
    id: "telemetry_v11_domain_activate",
    methods: ["POST"],
    authority: "device",
  },
  {
    pathname: "/api/v1/device/sync/manifest",
    id: "device_sync_manifest",
    methods: ["GET"],
    authority: "device",
  },
  {
    pathname: "/api/v1/me/devices",
    id: "participant_devices",
    methods: ["GET"],
    authority: "session",
  },
  {
    pathname: "/api/v1/me/devices/revoke",
    id: "participant_device_revocation",
    methods: ["POST"],
    authority: "session",
  },
  {
    pathname: "/api/v1/envelope-key",
    id: "envelope_key",
    methods: ["GET"],
    authority: "public",
  },
  {
    pathname: "/api/v1/contributions",
    id: "contributions",
    methods: ["POST"],
    authority: "upload",
  },
  {
    pathname: "/api/v1/me/export",
    id: "participant_export",
    methods: ["GET"],
    authority: "session",
  },
  {
    pathname: "/api/v1/community/daily",
    id: "community_daily",
    methods: ["GET"],
    authority: "public",
  },
] as const satisfies readonly WorkerRouteDefinition[];

describe("Worker route registry", () => {
  it("recognizes every exact route and preserves stable log classifications", () => {
    expect(EXACT_ROUTES).toHaveLength(36);
    expect(WORKER_ROUTE_POLICY).toEqual(EXACT_ROUTES);
    expect(Object.isFrozen(WORKER_ROUTE_POLICY)).toBe(true);
    for (const definition of WORKER_ROUTE_POLICY) {
      expect(Object.isFrozen(definition)).toBe(true);
      if (definition.methods !== "all") {
        expect(Object.isFrozen(definition.methods)).toBe(true);
      }
    }
    for (const { pathname, id, methods, authority } of EXACT_ROUTES) {
      expect(matchWorkerRoute(pathname), pathname).toEqual({
        kind: "exact",
        id,
        routeClass: id,
        methods,
        authority,
      });
      const match = matchWorkerRoute(pathname);
      if (match.kind === "exact" && match.methods !== "all") {
        expect(Object.isFrozen(match.methods), pathname).toBe(true);
      }
    }
  });

  it("keeps retired API paths absent instead of aliasing or reviving them", () => {
    for (const pathname of [
      "/api/v1/me",
      "/api/v1/recover",
      "/api/v1/me/upload-authorizations",
      "/api/v1/me/contributions/read",
      "/api/v1/me/contributions/delete",
      "/api/v1/me/stats",
      "/api/v1/me/insights",
      "/api/v1/stats/aggregate",
      "/api/v1/community/insights",
    ]) {
      expect(matchWorkerRoute(pathname), pathname).toEqual({
        kind: "unknown_api",
        id: "unknown_api",
        routeClass: "unknown_api",
      });
    }
  });

  it("enforces every declared method envelope at runtime", async () => {
    const exercisedMethods = ["GET", "POST", "DELETE", "PUT"] as const;
    for (const definition of WORKER_ROUTE_POLICY) {
      if (definition.methods === "all") continue;
      for (const method of exercisedMethods) {
        const response = await handleRequest(
          new Request(`https://worker.test${definition.pathname}`, { method }),
          {} as never,
        );
        if (definition.methods.some((allowed) => allowed === method)) {
          expect(response.status, `${method} ${definition.pathname}`).not.toBe(405);
        } else {
          expect(response.status, `${method} ${definition.pathname}`).toBe(405);
          expect(response.headers.get("allow"), definition.pathname).toBe(
            definition.methods.join(", "),
          );
        }
      }
    }
  });

  it("keeps matching exact and distinguishes unknown APIs from assets", () => {
    for (const pathname of [
      "/api/v1/enroll/",
      "/api/v1/not-a-route",
      "/api/health/",
      "/api/v1/device/sync-capabilities/",
      "/api/v1/me/device-telemetry-consents/",
      "/api/v1/device/telemetry/v1.1/day-manifests/",
      "/api/v1/me/telemetry-v11/domain-predecessor/",
      "/api/v1/me/telemetry-v11/domain-activate/",
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
