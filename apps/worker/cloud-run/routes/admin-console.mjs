/**
 * The six admin console routes on the PostgreSQL origin (GCP, C-ADMIN), as
 * one family for the composition root to register (D-CRB). Nothing here is
 * registered in the host. OD-CR-3 keeps the admin host refused until the
 * admin routes are ported; whether this family, with the overview at 503
 * until its unsourced blocks have sources, counts as ported is an open owner
 * question, so registering it is not a decision this module takes.
 *
 * Root contract (d43c8f92 handleRequest, admin-hostname branch):
 * 1. A request on the admin host first passes the chokepoint
 *    (createPostgresAdminAccessChokepoint from src/postgres-admin-access.ts,
 *    built once over the frozen env). Its ApiError (403 ACCESS_REQUIRED,
 *    403 ADMIN_REQUIRED, 503 ADMIN_NOT_CONFIGURED) is the answer, rendered
 *    with no-store and no Allow, for every path on the admin host.
 * 2. For the six ids, the root registers {requestId, routeId,
 *    adminIdentityKey} on the exact Request (postgres-request-context.mjs)
 *    and calls the handler from createAdminConsoleHandlers. The registry
 *    method envelope must NOT run first for these ids: the handler answers
 *    its own 405, after the identity check, as the Worker does.
 * 3. On the apex host the six ids are 404 NOT_FOUND (the edge already answers
 *    them locally; the root keeps the Worker's answer as defense in depth).
 *
 * Defaults: every PostgreSQL reader and writer is bound here from the primary
 * pool and schema. Admin reads with no GCP source stay unavailable unless the
 * root injects one (see the route modules and src/postgres-admin-overview.ts).
 * The database-health analytics role defaults to the primary pool, because
 * primary migration 0059 places the analytics_v2 tables in that database.
 */

import { beginPostgresAdminOperation, finishPostgresAdminOperation,
  finishPostgresAdminOperationBestEffort } from "../../src/postgres-admin-audit.ts";
import { readPostgresAdminAllowancePreview } from "../../src/postgres-admin-allowance-preview.ts";
import { setPostgresCollectionControls } from "../../src/postgres-admin-collection-controls.ts";
import { readPostgresAdminDatabaseHealth } from "../../src/postgres-admin-database-health.ts";
import { readPostgresAdminOverview } from "../../src/postgres-admin-overview.ts";
import { assertFrozenPathnames } from "../postgres-family-contract.mjs";
import { ADMIN_ACTION_PATHNAMES, createAdminActionDispatch } from "./admin-action.mjs";
import {
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_PATHNAMES,
  createAdminCommunityAllowancePreviewDispatch,
} from "./admin-community-allowance-preview.mjs";
import { ADMIN_DATABASE_HEALTH_PATHNAMES, createAdminDatabaseHealthDispatch } from "./admin-database-health.mjs";
import { ADMIN_METRICS_HISTORY_PATHNAMES, createAdminMetricsHistoryDispatch } from "./admin-metrics-history.mjs";
import { ADMIN_OVERVIEW_PATHNAMES, createAdminOverviewDispatch } from "./admin-overview.mjs";
import {
  ADMIN_RECONSTRUCTION_PROGRESS_PATHNAMES,
  createAdminReconstructionProgressDispatch,
} from "./admin-reconstruction-progress.mjs";
import { adminRouteConfigurationError, assertAdminFamilyDeps } from "./admin-route-support.mjs";

/** Route id -> pathname, in WORKER_ROUTE_POLICY order (route-registry.ts). */
export const ADMIN_CONSOLE_ROUTES = Object.freeze([
  Object.freeze({ id: "admin_overview", pathname: ADMIN_OVERVIEW_PATHNAMES[0], method: "GET" }),
  Object.freeze({ id: "admin_metrics_history", pathname: ADMIN_METRICS_HISTORY_PATHNAMES[0], method: "GET" }),
  Object.freeze({
    id: "admin_community_allowance_preview",
    pathname: ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_PATHNAMES[0],
    method: "GET",
  }),
  Object.freeze({ id: "admin_database_health", pathname: ADMIN_DATABASE_HEALTH_PATHNAMES[0], method: "GET" }),
  Object.freeze({
    id: "admin_reconstruction_progress",
    pathname: ADMIN_RECONSTRUCTION_PROGRESS_PATHNAMES[0],
    method: "GET",
  }),
  Object.freeze({ id: "admin_action", pathname: ADMIN_ACTION_PATHNAMES[0], method: "POST" }),
]);

export const ADMIN_CONSOLE_ROUTE_IDS = Object.freeze(ADMIN_CONSOLE_ROUTES.map((route) => route.id));
export const ADMIN_CONSOLE_PATHNAMES = assertFrozenPathnames(
  Object.freeze(ADMIN_CONSOLE_ROUTES.map((route) => route.pathname)),
);

const OVERVIEW_SOURCE_KEYS = Object.freeze(["syntheticContributions", "historicalPublication", "deletionLedger"]);
/**
 * The pools and schema options a composition root may pass. The PostgreSQL
 * line has one database and no deletion ledger (decisions D2, D4 and D6 of
 * 2026-09-26), so any other key, a ledger pool or schema from a stale root
 * included, is refused rather than ignored.
 */
const POOL_KEYS = Object.freeze(["primary", "analytics"]);
const SCHEMA_OPTION_KEYS = Object.freeze(["primarySchema"]);

function closedKeys(value, allowed) {
  return value !== null && typeof value === "object" && Object.keys(value).every((key) => allowed.includes(key));
}

function isPool(value) {
  return value !== null && typeof value === "object" && typeof value.connect === "function";
}

function optionalPool(name, value) {
  if (value !== undefined && !isPool(value)) throw adminRouteConfigurationError("admin_console", name);
  return value;
}

/**
 * Bind the default PostgreSQL adapters.
 *
 * deps (FC-3): requestContext, clock?, env (frozen Worker-shaped env),
 *   pools: {primary, analytics?} (analytics defaults to primary, where 0059
 *     places analytics_v2; an explicit analytics pool is probed as given and
 *     never falls back to primary). There is no ledger pool: the database
 *     health's deletion_ledger role is always 'not_configured' (how the
 *     closed DTO represents the retired role is OWN-17 question 3),
 *   schemaOptions: {primarySchema},
 *   overviewSources?: {syntheticContributions?, historicalPublication?, deletionLedger?}
 *     (none has a default: each block is the Worker's 503 until the root
 *     injects its source, which OWN-17 question 1 decides),
 *   readMetricsHistory?, readReconstructionProgress? (no GCP source: unavailable),
 *   maintenance?: {runMaintenance?, syncDistribution?, telemetryRuntimeActivation?,
 *     transportRollback?, v11EvidenceAdoption?} (unported: 503 POSTGRES_ROUTE_NOT_PORTED).
 */
export function createAdminConsoleAdapters(deps) {
  assertAdminFamilyDeps("admin_console", deps);
  const pools = deps.pools;
  if (pools === null || typeof pools !== "object" || !isPool(pools.primary)) {
    throw adminRouteConfigurationError("admin_console", "pools.primary");
  }
  if (!closedKeys(pools, POOL_KEYS)) throw adminRouteConfigurationError("admin_console", "pools");
  // The analytics role's database is the primary database on GCP (0059).
  const analyticsPool = optionalPool("pools.analytics", pools.analytics) ?? pools.primary;
  const schema = deps.schemaOptions?.primarySchema;
  if (typeof schema !== "string" || !closedKeys(deps.schemaOptions, SCHEMA_OPTION_KEYS)) {
    throw adminRouteConfigurationError("admin_console", "schemaOptions");
  }
  const env = deps.env;
  if (env === null || typeof env !== "object" || !Object.isFrozen(env)) {
    throw adminRouteConfigurationError("admin_console", "env");
  }
  const injected = deps.overviewSources ?? {};
  if (injected === null || typeof injected !== "object"
      || Object.keys(injected).some((key) => !OVERVIEW_SOURCE_KEYS.includes(key)
        || typeof injected[key] !== "function")) {
    throw adminRouteConfigurationError("admin_console", "overviewSources");
  }
  const overviewSources = Object.freeze({ ...injected });
  const clock = deps.clock ?? Date.now;
  return Object.freeze({
    readOverview: ({ nowEpoch, diagnosticReference }) => readPostgresAdminOverview({
      pool: pools.primary, schema, env, nowEpoch, diagnosticReference, sources: overviewSources,
    }),
    readAllowancePreview: ({ nowEpoch }) => readPostgresAdminAllowancePreview(pools.primary, schema, nowEpoch),
    readDatabaseHealth: () => readPostgresAdminDatabaseHealth({
      env, clock, pools: { primary: pools.primary, analytics: analyticsPool },
    }),
    ...(deps.readMetricsHistory === undefined ? {} : { readMetricsHistory: deps.readMetricsHistory }),
    ...(deps.readReconstructionProgress === undefined ? {}
      : { readReconstructionProgress: deps.readReconstructionProgress }),
    setCollectionControls: (input) => setPostgresCollectionControls(pools.primary, schema, input),
    beginAudit: (input) => beginPostgresAdminOperation(pools.primary, schema, input),
    finishAudit: (input) => finishPostgresAdminOperation(pools.primary, schema, input),
    finishAuditBestEffort: (input) => finishPostgresAdminOperationBestEffort(pools.primary, schema, input),
    maintenance: deps.maintenance ?? {},
  });
}

/**
 * The six handlers keyed by route id, each async (request) => Response. A
 * root that passes deps.admin uses those adapters instead of the defaults
 * (tests and the edge-test origin).
 */
export function createAdminConsoleHandlers(deps) {
  assertAdminFamilyDeps("admin_console", deps);
  const admin = deps.admin ?? createAdminConsoleAdapters(deps);
  const familyDeps = Object.freeze({ requestContext: deps.requestContext, clock: deps.clock, admin });
  return new Map([
    ["admin_overview", createAdminOverviewDispatch(familyDeps)],
    ["admin_metrics_history", createAdminMetricsHistoryDispatch(familyDeps)],
    ["admin_community_allowance_preview", createAdminCommunityAllowancePreviewDispatch(familyDeps)],
    ["admin_database_health", createAdminDatabaseHealthDispatch(familyDeps)],
    ["admin_reconstruction_progress", createAdminReconstructionProgressDispatch(familyDeps)],
    ["admin_action", createAdminActionDispatch(familyDeps)],
  ]);
}

/** One FC-2 dispatcher over ADMIN_CONSOLE_PATHNAMES (exact pathname match). */
export function createAdminConsoleDispatch(deps) {
  const handlers = createAdminConsoleHandlers(deps);
  const byPathname = new Map(ADMIN_CONSOLE_ROUTES.map((route) => [route.pathname, handlers.get(route.id)]));
  return async function adminConsoleDispatch(request) {
    const handler = byPathname.get(new URL(request.url).pathname);
    if (handler === undefined) {
      throw adminRouteConfigurationError("admin_console", "a pathname outside ADMIN_CONSOLE_PATHNAMES");
    }
    return handler(request);
  };
}
