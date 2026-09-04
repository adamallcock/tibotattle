export type WorkerRouteMethod = "GET" | "POST" | "DELETE";

export type WorkerRouteAuthority =
  | "none"
  | "public"
  | "enrollment"
  | "accountless_enrollment"
  | "handoff"
  | "session"
  | "device"
  | "upload"
  | "pairing_code"
  | "admin"
  | "operator";

export interface WorkerRouteDefinition {
  readonly pathname: string;
  readonly id: string;
  readonly methods: readonly WorkerRouteMethod[] | "all";
  readonly authority: WorkerRouteAuthority;
}

const EXACT_WORKER_ROUTE_DEFINITIONS = [
  // Services ID registration no longer requires a server association file.
  // Intercept the historical filename only so SPA fallback cannot present
  // index.html as a purported verification response; it always returns 404.
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
    pathname: "/api/v1/accountless/enrollment",
    id: "accountless_enrollment",
    methods: ["POST"],
    authority: "accountless_enrollment",
  },
  {
    pathname: "/api/v1/internal/release/appcast",
    id: "sparkle_appcast_guard",
    methods: ["POST"],
    authority: "operator",
  },
  // Both hosted providers use the same three-route handoff: the dashboard
  // starts a sign-in, the provider redirects to this service's own callback,
  // and the dashboard reads the one-time result back keyed by an unguessable
  // state. Nothing about a sign-in ever returns to a client-owned redirect.
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
    // Silent auto-renewal: a valid, unexpired device bearer rotates its own
    // secret in place (same device, no new slot, no browser sign-in), so the
    // 30-day credential never lapses under active use.
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

type ExactWorkerRouteDefinition =
  (typeof EXACT_WORKER_ROUTE_DEFINITIONS)[number];

export const WORKER_ROUTE_POLICY: readonly Readonly<WorkerRouteDefinition>[] =
  Object.freeze(EXACT_WORKER_ROUTE_DEFINITIONS.map((definition) =>
    Object.freeze({
      pathname: definition.pathname,
      id: definition.id,
      methods: definition.methods === "all"
        ? "all"
        : Object.freeze([...definition.methods]),
      authority: definition.authority,
    })
  ));

export type ExactWorkerRouteId = ExactWorkerRouteDefinition["id"];
export type ApiWorkerRouteId = Exclude<
  ExactWorkerRouteId,
  "health" | "ready"
>;

export type WorkerRouteMatch =
  | Readonly<{
      kind: "exact";
      id: ExactWorkerRouteId;
      routeClass: ExactWorkerRouteId;
      methods: readonly WorkerRouteMethod[] | "all";
      authority: WorkerRouteAuthority;
    }>
  | Readonly<{
      kind: "unknown_api";
      id: "unknown_api";
      routeClass: "unknown_api";
    }>
  | Readonly<{
      kind: "asset";
      id: "asset";
      routeClass: "asset";
    }>;

const EXACT_WORKER_ROUTES = new Map<string, WorkerRouteMatch>();
for (const definition of EXACT_WORKER_ROUTE_DEFINITIONS) {
  if (EXACT_WORKER_ROUTES.has(definition.pathname)) {
    throw new Error("Duplicate Worker route pathname");
  }
  EXACT_WORKER_ROUTES.set(definition.pathname, Object.freeze({
    kind: "exact",
    id: definition.id,
    routeClass: definition.id,
    methods: definition.methods === "all"
      ? "all"
      : Object.freeze([...definition.methods]),
    authority: definition.authority,
  }));
}

const UNKNOWN_API_ROUTE = Object.freeze({
  kind: "unknown_api",
  id: "unknown_api",
  routeClass: "unknown_api",
} as const);

const ASSET_ROUTE = Object.freeze({
  kind: "asset",
  id: "asset",
  routeClass: "asset",
} as const);

export function matchWorkerRoute(pathname: string): WorkerRouteMatch {
  const exact = EXACT_WORKER_ROUTES.get(pathname);
  if (exact) return exact;
  return pathname.startsWith("/api/") ? UNKNOWN_API_ROUTE : ASSET_ROUTE;
}
