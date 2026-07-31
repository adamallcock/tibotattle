interface WorkerRouteDefinition {
  readonly pathname: string;
  readonly id: string;
}

const EXACT_WORKER_ROUTE_DEFINITIONS = [
  { pathname: "/api/health", id: "health" },
  { pathname: "/api/ready", id: "ready" },
  { pathname: "/api/v1/enroll", id: "enroll" },
  { pathname: "/api/v1/recover", id: "recover" },
  { pathname: "/api/v1/session", id: "session" },
  { pathname: "/api/v1/logout", id: "logout" },
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
