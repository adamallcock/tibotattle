interface WorkerRouteDefinition {
  readonly pathname: string;
  readonly id: string;
}

const EXACT_WORKER_ROUTE_DEFINITIONS = [
  // Services ID registration no longer requires a server association file.
  // Intercept the historical filename only so SPA fallback cannot present
  // index.html as a purported verification response; it always returns 404.
  {
    pathname: "/.well-known/apple-developer-domain-association.txt",
    id: "apple_domain_association",
  },
  { pathname: "/api/health", id: "health" },
  { pathname: "/api/ready", id: "ready" },
  { pathname: "/api/v1/enroll", id: "enroll" },
  // Both hosted providers use the same three-route handoff: the dashboard
  // starts a sign-in, the provider redirects to this service's own callback,
  // and the dashboard reads the one-time result back keyed by an unguessable
  // state. Nothing about a sign-in ever returns to a client-owned redirect.
  { pathname: "/api/v1/identity/google/start", id: "identity_google_start" },
  {
    pathname: "/api/v1/identity/google/callback",
    id: "identity_google_callback",
  },
  { pathname: "/api/v1/identity/google/result", id: "identity_google_result" },
  { pathname: "/api/v1/identity/apple/start", id: "identity_apple_start" },
  {
    pathname: "/api/v1/identity/apple/callback",
    id: "identity_apple_callback",
  },
  { pathname: "/api/v1/identity/apple/result", id: "identity_apple_result" },
  { pathname: "/api/v1/recover", id: "recover" },
  { pathname: "/api/v1/session", id: "session" },
  { pathname: "/api/v1/logout", id: "logout" },
  { pathname: "/api/v1/admin/overview", id: "admin_overview" },
  { pathname: "/api/v1/admin/action", id: "admin_action" },
  {
    pathname: "/api/v1/me/security-reset",
    id: "security_reset",
  },
  {
    pathname: "/api/v1/me/upload-authorizations",
    id: "upload_authorization",
  },
  {
    pathname: "/api/v1/me/device-pairings",
    id: "device_pairing",
  },
  {
    pathname: "/api/v1/device-pairings/claim",
    id: "device_pairing_claim",
  },
  {
    pathname: "/api/v1/device/upload-authorizations",
    id: "device_upload_authorization",
  },
  {
    pathname: "/api/v1/device/disconnect",
    id: "device_disconnect",
  },
  {
    pathname: "/api/v1/me/devices",
    id: "participant_devices",
  },
  {
    pathname: "/api/v1/me/devices/revoke",
    id: "participant_device_revocation",
  },
  {
    pathname: "/api/v1/envelope-key",
    id: "envelope_key",
  },
  {
    pathname: "/api/v1/contributions",
    id: "contributions",
  },
  {
    pathname: "/api/v1/me/contributions/read",
    id: "contribution_read",
  },
  {
    pathname: "/api/v1/me/contributions/delete",
    id: "contribution_delete",
  },
  {
    pathname: "/api/v1/me/export",
    id: "participant_export",
  },
  {
    pathname: "/api/v1/me/stats",
    id: "participant_stats",
  },
  {
    pathname: "/api/v1/me/insights",
    id: "participant_stats",
  },
  {
    pathname: "/api/v1/stats/aggregate",
    id: "community_stats",
  },
  {
    pathname: "/api/v1/community/insights",
    id: "community_stats",
  },
  {
    pathname: "/api/v1/me",
    id: "participant",
  },
] as const satisfies readonly WorkerRouteDefinition[];

type ExactWorkerRouteDefinition =
  (typeof EXACT_WORKER_ROUTE_DEFINITIONS)[number];

export const WORKER_ROUTE_POLICY: readonly Readonly<WorkerRouteDefinition>[] =
  Object.freeze(EXACT_WORKER_ROUTE_DEFINITIONS.map((definition) =>
    Object.freeze({
      pathname: definition.pathname,
      id: definition.id,
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
