/**
 * CR-6: the production route registry of the Cloud Run origin (phase A).
 *
 * One registry for the three origin modes (production, edge-test and the
 * loopback fastpath-test). It classifies every route of the Worker's
 * WORKER_ROUTE_POLICY (src/route-registry.ts, byte-identical at the parity
 * basis d43c8f92 and at the wave-2 base) and gives each one exactly one
 * disposition:
 * - ported: served by an injected family handler;
 * - unported: answered by the request handler with the closed
 *   503 POSTGRES_ROUTE_NOT_PORTED (retry-after 60), never by a family;
 * - root: answered by the request handler itself, as the Worker answers it
 *   (apple_domain_association 404 for every method; the disabled Sparkle
 *   appcast guard 405 Allow: POST, else 404). The edge answers both first.
 *
 * PRODUCTION_ROUTE_TABLE pins the 51 routes in Worker order (their position
 * in the d43c8f92 policy) with their class:
 * - scope (21): ported by this item's scope (CR-6/CR-7, RD-2, RD-3);
 * - od-cr-1 (9): ported in fastpath-test and edge-test but not named in
 *   scope; the open owner decision OD-CR-1 picks which ones production
 *   serves;
 * - od-cr-2 (19): unported; OD-CR-2 decides per route whether it is ported
 *   before the flip or answers 503 at cutover;
 * - root (2).
 * The ported set is INJECTED (OD-CR-1, no default): it must contain every
 * scope route and may add any subset of the od-cr-1 routes. Porting an
 * od-cr-2 route needs the owner's OD-CR-2 answer and a reviewed change of
 * its class here first.
 *
 * Retired by append-only (accepted decision 2026-09-26, Variant B offline
 * purge): no online erasure route exists. DELETE /api/v1/me is outside the
 * policy and answers 404 NOT_FOUND (unknown_api); admin_action is unported,
 * and its participantErasure branch (d43c8f92 index.ts handleAdminAction) is
 * never part of a port. RETIRED_ONLINE_ERASURE_SURFACES records both.
 *
 * Plain ESM with no imports: the policy is injected (the request handler
 * then requires it to be the Worker's own WORKER_ROUTE_POLICY object).
 * Every refusal is a TypeError whose code is one of
 * PRODUCTION_ROUTE_REGISTRY_CODES; nothing else is put into an error.
 */

export const ORIGIN_ROUTE_DISPOSITIONS = Object.freeze({
  PORTED: "ported",
  UNPORTED: "unported",
  ROOT: "root",
});

/** Route classes of PRODUCTION_ROUTE_TABLE. */
export const PRODUCTION_ROUTE_CLASSES = Object.freeze({
  SCOPE: "scope",
  OD_CR_1: "od-cr-1",
  OD_CR_2: "od-cr-2",
  ROOT: "root",
});

export const ORIGIN_ROOT_ROUTE_IDS = Object.freeze(["apple_domain_association", "sparkle_appcast_guard"]);

/**
 * The parity basis this table was derived from (OD-CR-9 keeps the pin
 * unverified until the owner reads production's deployment.sourceCommit).
 * policySha256 is the sha256 of
 * JSON.stringify(policy.map((r) => [r.id, r.pathname, r.methods, r.authority]))
 * with methods 'all' kept as the string; the registry check recomputes it
 * from src/route-registry.ts, so any policy change fails until the table is
 * re-derived.
 */
export const PRODUCTION_ROUTE_PARITY_BASIS = Object.freeze({
  commit: "d43c8f92",
  routeCount: 51,
  policySha256: "905a5496ff777802f05b0d6ef569d73face0a4e160be4f6dd308c26356d1943f",
});

const S = PRODUCTION_ROUTE_CLASSES.SCOPE;
const C = PRODUCTION_ROUTE_CLASSES.OD_CR_1;
const U = PRODUCTION_ROUTE_CLASSES.OD_CR_2;
const R = PRODUCTION_ROUTE_CLASSES.ROOT;

/** Every d43c8f92 production route, in Worker (policy) order, with its class. */
export const PRODUCTION_ROUTE_TABLE = Object.freeze([
  ["apple_domain_association", R],
  ["health", S],
  ["ready", S],
  ["enroll", U],
  ["accountless_enrollment", S],
  ["accountless_ownership", S],
  ["accountless_telemetry_v12_authorization", S],
  ["accountless_telemetry_performance_authorization", U],
  ["accountless_renewal", S],
  ["sparkle_appcast_guard", R],
  ["identity_google_start", U],
  ["identity_google_callback", U],
  ["identity_google_result", U],
  ["identity_apple_start", U],
  ["identity_apple_callback", U],
  ["identity_apple_result", U],
  ["session", C],
  ["logout", C],
  ["admin_overview", U],
  ["admin_metrics_history", U],
  ["admin_community_allowance_preview", U],
  ["admin_database_health", U],
  ["admin_reconstruction_progress", U],
  ["admin_action", U],
  ["security_reset", U],
  ["device_pairing", C],
  ["device_pairing_claim", C],
  ["device_upload_authorization", S],
  ["device_disconnect", C],
  ["device_credential_renew", C],
  ["device_sync_state", S],
  ["device_sync_capabilities", S],
  ["device_sync_capabilities_v12", S],
  ["telemetry_performance_capabilities", U],
  ["telemetry_performance_consent", U],
  ["telemetry_performance_reports", U],
  ["telemetry_v11_consent", S],
  ["telemetry_v12_consent", C],
  ["telemetry_v11_day_manifests", S],
  ["telemetry_v12_day_manifests", S],
  ["telemetry_v11_domain_predecessor", S],
  ["telemetry_v11_domain_activate", S],
  ["telemetry_v12_domain_predecessor", S],
  ["telemetry_v12_domain_activate", S],
  ["device_sync_manifest", S],
  ["participant_devices", C],
  ["participant_device_revocation", C],
  ["envelope_key", S],
  ["contributions", S],
  ["participant_export", U],
  ["community_daily", S],
].map(([id, routeClass], index) => Object.freeze({ workerOrder: index + 1, id, routeClass })));

function idsOfClass(routeClass) {
  return Object.freeze(PRODUCTION_ROUTE_TABLE
    .filter((route) => route.routeClass === routeClass)
    .map((route) => route.id));
}

/** The 21 routes this item ports in production. */
export const POSTGRES_SCOPE_ROUTE_IDS = idsOfClass(S);
/** OD-CR-1: the 9 routes fastpath-test and edge-test serve that production may add. */
export const OD_CR_1_CONTESTED_ROUTE_IDS = idsOfClass(C);
/** OD-CR-2: the 19 routes the origin does not serve. */
export const OD_CR_2_UNPORTED_ROUTE_IDS = idsOfClass(U);

/** Online-erasure surfaces retired under append-only; neither is a registry route. */
export const RETIRED_ONLINE_ERASURE_SURFACES = Object.freeze([
  Object.freeze({
    surface: "DELETE /api/v1/me",
    routeId: null,
    originAnswer: "404 NOT_FOUND (unknown_api)",
  }),
  Object.freeze({
    surface: "POST /api/v1/admin/action participantErasure",
    routeId: "admin_action",
    originAnswer: "503 POSTGRES_ROUTE_NOT_PORTED; a later admin_action port omits this branch",
  }),
]);

/** Every code this module throws. */
export const PRODUCTION_ROUTE_REGISTRY_CODES = Object.freeze([
  "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE",
  "PRODUCTION_ROUTE_PARITY_BASIS_DRIFT",
  "PRODUCTION_ROUTE_PORTED_SET_INVALID",
  "PRODUCTION_ROUTE_ROOT_CLAIMED",
  "PRODUCTION_ROUTE_PORT_UNDECIDED",
  "PRODUCTION_ROUTE_SCOPE_INCOMPLETE",
  "PRODUCTION_ROUTE_HANDLERS_INVALID",
  "PRODUCTION_ROUTE_HANDLER_UNEXPECTED",
  "PRODUCTION_ROUTE_HANDLER_MISSING",
  "PRODUCTION_ROUTE_UNKNOWN",
]);

const TABLE_BY_ID = new Map(PRODUCTION_ROUTE_TABLE.map((route) => [route.id, route]));
const ROOT_IDS = new Set(ORIGIN_ROOT_ROUTE_IDS);
const ROUTE_METHODS = new Set(["GET", "POST", "DELETE"]);

/** Registries createProductionRouteRegistry issued; nothing else is a registry. */
const issuedRegistries = new WeakSet();

function refuse(code) {
  throw Object.assign(new TypeError(code), { code });
}

function validPolicyEntry(entry) {
  return entry !== null && typeof entry === "object"
    && typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.pathname === "string" && entry.pathname.startsWith("/")
    && (entry.methods === "all"
      || (Array.isArray(entry.methods) && entry.methods.length > 0
        && entry.methods.every((method) => ROUTE_METHODS.has(method))));
}

/** 51 well-formed entries with distinct ids and pathnames, in the pinned order. */
function validatedPolicy(routePolicy) {
  if (!Array.isArray(routePolicy)
      || routePolicy.length !== PRODUCTION_ROUTE_PARITY_BASIS.routeCount
      || !routePolicy.every(validPolicyEntry)
      || new Set(routePolicy.map((entry) => entry.id)).size !== routePolicy.length
      || new Set(routePolicy.map((entry) => entry.pathname)).size !== routePolicy.length) {
    refuse("PRODUCTION_ROUTE_COVERAGE_INCOMPLETE");
  }
  if (routePolicy.some((entry, index) => entry.id !== PRODUCTION_ROUTE_TABLE[index].id)) {
    // Same size, different routes or order: the classification no longer
    // describes this policy (OD-CR-9 re-derivation).
    refuse("PRODUCTION_ROUTE_PARITY_BASIS_DRIFT");
  }
  return routePolicy;
}

/** The injected ported set: scope plus any OD-CR-1 subset, nothing else. */
function validatedPortedIds(portedRouteIds, policyIds) {
  if (!Array.isArray(portedRouteIds)
      || portedRouteIds.some((id) => typeof id !== "string")
      || new Set(portedRouteIds).size !== portedRouteIds.length) {
    refuse("PRODUCTION_ROUTE_PORTED_SET_INVALID");
  }
  for (const id of portedRouteIds) {
    if (!policyIds.has(id)) refuse("PRODUCTION_ROUTE_COVERAGE_INCOMPLETE");
    if (ROOT_IDS.has(id)) refuse("PRODUCTION_ROUTE_ROOT_CLAIMED");
    if (TABLE_BY_ID.get(id).routeClass === U) refuse("PRODUCTION_ROUTE_PORT_UNDECIDED");
  }
  const ported = new Set(portedRouteIds);
  if (POSTGRES_SCOPE_ROUTE_IDS.some((id) => !ported.has(id))) refuse("PRODUCTION_ROUTE_SCOPE_INCOMPLETE");
  return ported;
}

/** A snapshot of the handler Map: exactly one function per ported id. */
function validatedHandlers(handlers, ported) {
  if (!(handlers instanceof Map)) refuse("PRODUCTION_ROUTE_HANDLERS_INVALID");
  const snapshot = new Map(handlers);
  for (const key of snapshot.keys()) {
    if (ROOT_IDS.has(key)) refuse("PRODUCTION_ROUTE_ROOT_CLAIMED");
    if (!ported.has(key)) refuse("PRODUCTION_ROUTE_HANDLER_UNEXPECTED");
  }
  for (const id of ported) {
    if (typeof snapshot.get(id) !== "function") refuse("PRODUCTION_ROUTE_HANDLER_MISSING");
  }
  return snapshot;
}

/**
 * Build the registry. routePolicy is the Worker's WORKER_ROUTE_POLICY;
 * handlers a Map<routeId, (request) => Promise<Response>>; portedRouteIds
 * the injected OD-CR-1 answer (required, no default). Refusals, in order:
 * - PRODUCTION_ROUTE_COVERAGE_INCOMPLETE: the policy is not 51 well-formed
 *   entries with distinct ids and pathnames, or a ported id is not in it;
 * - PRODUCTION_ROUTE_PARITY_BASIS_DRIFT: 51 entries, but not the pinned
 *   routes in the pinned order;
 * - PRODUCTION_ROUTE_PORTED_SET_INVALID: portedRouteIds is not an array of
 *   distinct strings;
 * - PRODUCTION_ROUTE_ROOT_CLAIMED: a root route is ported or has a handler;
 * - PRODUCTION_ROUTE_PORT_UNDECIDED: an od-cr-2 route is ported;
 * - PRODUCTION_ROUTE_SCOPE_INCOMPLETE: a scope route is not ported;
 * - PRODUCTION_ROUTE_HANDLERS_INVALID: handlers is not a Map;
 * - PRODUCTION_ROUTE_HANDLER_UNEXPECTED: a handler key outside the ported
 *   set (an unported id, a pathname such as the v1.2 effective page, or
 *   any other key);
 * - PRODUCTION_ROUTE_HANDLER_MISSING: a ported id without a function.
 *
 * Returns a frozen registry: resolve(routeId) gives a frozen
 * { disposition, handler } (handler null unless ported; an id outside the
 * policy throws PRODUCTION_ROUTE_UNKNOWN); portedRouteIds and
 * portedPathnames in Worker order; unportedRouteIds sorted; rootRouteIds;
 * coverage 'complete' (ported + unported + root is exactly the policy).
 */
export function createProductionRouteRegistry({ routePolicy, handlers, portedRouteIds } = {}) {
  const policy = validatedPolicy(routePolicy);
  const policyIds = new Set(policy.map((entry) => entry.id));
  const ported = validatedPortedIds(portedRouteIds, policyIds);
  const snapshot = validatedHandlers(handlers, ported);
  const resolutions = new Map();
  for (const entry of policy) {
    const disposition = ROOT_IDS.has(entry.id)
      ? ORIGIN_ROUTE_DISPOSITIONS.ROOT
      : ported.has(entry.id) ? ORIGIN_ROUTE_DISPOSITIONS.PORTED : ORIGIN_ROUTE_DISPOSITIONS.UNPORTED;
    resolutions.set(entry.id, Object.freeze({
      disposition,
      handler: disposition === ORIGIN_ROUTE_DISPOSITIONS.PORTED ? snapshot.get(entry.id) : null,
    }));
  }
  const portedEntries = policy.filter((entry) => ported.has(entry.id));
  const unportedRouteIds = Object.freeze(policy
    .filter((entry) => resolutions.get(entry.id).disposition === ORIGIN_ROUTE_DISPOSITIONS.UNPORTED)
    .map((entry) => entry.id)
    .sort());
  const registry = Object.freeze({
    routePolicy: policy,
    parityBasis: PRODUCTION_ROUTE_PARITY_BASIS,
    portedRouteIds: Object.freeze(portedEntries.map((entry) => entry.id)),
    portedPathnames: Object.freeze(portedEntries.map((entry) => entry.pathname)),
    unportedRouteIds,
    rootRouteIds: ORIGIN_ROOT_ROUTE_IDS,
    coverage: "complete",
    resolve(routeId) {
      const resolution = typeof routeId === "string" ? resolutions.get(routeId) : undefined;
      if (resolution === undefined) refuse("PRODUCTION_ROUTE_UNKNOWN");
      return resolution;
    },
  });
  issuedRegistries.add(registry);
  return registry;
}

/** True only for a registry createProductionRouteRegistry issued (not a copy). */
export function isProductionRouteRegistry(value) {
  return value !== null && typeof value === "object" && issuedRegistries.has(value);
}
