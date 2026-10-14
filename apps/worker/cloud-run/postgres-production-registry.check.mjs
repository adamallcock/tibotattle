import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  ADMIN_HOST_ROUTE_IDS,
  IDENTITY_LINK_CONSUMER_ROUTE_IDS,
  OD_CR_1_CONTESTED_ROUTE_IDS,
  ORIGIN_ROOT_ROUTE_IDS,
  ORIGIN_ROUTE_DISPOSITIONS,
  PERFORMANCE_ROUTE_IDS,
  POSTGRES_SCOPE_ROUTE_IDS,
  PRODUCTION_ROUTE_CLASSES,
  PRODUCTION_ROUTE_PARITY_BASIS,
  PRODUCTION_ROUTE_REGISTRY_CODES,
  PRODUCTION_ROUTE_TABLE,
  RETIRED_ONLINE_ERASURE_SURFACES,
  RETIRED_ROUTE_IDS,
  assertIdentityLinkConsumersRetired,
  createProductionRouteRegistry,
  isProductionRouteRegistry,
} from "./postgres-production-registry.mjs";
import { createOriginRouteModuleRegistry, defineOriginRouteModule } from "./origin-route-modules.mjs";
import { PERFORMANCE_TELEMETRY_PATHNAMES, PERFORMANCE_TELEMETRY_ROUTE_IDS } from "./routes/performance-telemetry.mjs";

// CR-6 registry without a database: the pinned d43c8f92 route table against
// the Worker's own WORKER_ROUTE_POLICY, the injected ported set (scope and
// the restored performance intake, required; the OD-CR-1 contested routes
// and the OD-CR-2 admin routes), the round-12 retired routes (the uniform
// 503), the production list in src/backend-composition.ts, the route-module
// fold (one registry) and every closed refusal. Every handler is a synthetic
// stub.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let vite;
let policy;
let matchWorkerRoute;
let productionPortedRouteIds;
let productionAdminRouteIds;
let communityModelPerformancePath;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  ({ WORKER_ROUTE_POLICY: policy, matchWorkerRoute } = await vite.ssrLoadModule("/src/route-registry.ts"));
  ({
    POSTGRES_PORTED_WORKER_ROUTE_IDS: productionPortedRouteIds,
    POSTGRES_ADMIN_HOST_ROUTE_IDS: productionAdminRouteIds,
  } = await vite.ssrLoadModule("/src/backend-composition.ts"));
  ({ ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PATH: communityModelPerformancePath } = await vite.ssrLoadModule(
    "/src/analytics-v2/community-model-performance-route.ts"));
});

after(async () => {
  await vite?.close();
});

/** The brief's 21 scope routes (host.json, ROUTE STATUS), independently of the table. */
const BRIEF_SCOPE = Object.freeze([
  "health", "ready", "envelope_key", "contributions", "community_daily", "device_upload_authorization",
  "telemetry_v11_consent", "telemetry_v11_day_manifests", "telemetry_v11_domain_predecessor",
  "telemetry_v11_domain_activate", "telemetry_v12_day_manifests", "telemetry_v12_domain_predecessor",
  "telemetry_v12_domain_activate", "device_sync_state", "device_sync_manifest", "device_sync_capabilities",
  "device_sync_capabilities_v12", "accountless_enrollment", "accountless_ownership",
  "accountless_telemetry_v12_authorization", "accountless_renewal",
]);
const BRIEF_CONTESTED = Object.freeze([
  "session", "logout", "participant_devices", "participant_device_revocation", "device_pairing",
  "device_pairing_claim", "telemetry_v12_consent", "device_disconnect", "device_credential_renew",
]);
/**
 * Owner round 12 (2026-10-02) retirements that still stand, listed
 * independently of the table: decision 1 of 2026-10-10 restored the three
 * performance intake routes and kept the signed-in consent route retired.
 */
const ROUND_12_RETIRED = Object.freeze([
  "enroll", "identity_google_start", "identity_google_callback", "identity_google_result", "identity_apple_start",
  "identity_apple_callback", "identity_apple_result", "security_reset", "participant_export",
  "telemetry_performance_consent",
]);
/** Owner decision 2026-10-10 (decision 1): the restored performance intake, in Worker order. */
const DECISION_1_PERFORMANCE = Object.freeze([
  "accountless_telemetry_performance_authorization", "telemetry_performance_capabilities",
  "telemetry_performance_reports",
]);
/**
 * The two owner-decided routes of 2026-10-10 (decision 7 and GATE-Q 5: the
 * public read, in the performance class; GATE-Q 4: the admin view, in the
 * admin class), listed independently of the table.
 */
const OWNER_DECIDED_2026_10_10 = Object.freeze(["admin_performance_intake", "community_model_performance"]);
/** The d43c8f92 parity basis before the owner-decided routes. */
const D43C8F92_POLICY_SHA256 = "905a5496ff777802f05b0d6ef569d73face0a4e160be4f6dd308c26356d1943f";
/** The smallest ported set the registry accepts: scope and performance. */
const REQUIRED = Object.freeze([...POSTGRES_SCOPE_ROUTE_IDS, ...PERFORMANCE_ROUTE_IDS]);
const EFFECTIVE_PAGE_PATH = "/api/v1/me/telemetry-v12/effective-page";

const observedCodes = new Set();

function stub(id) {
  const handler = async () => new Response(id, { status: 200 });
  Object.defineProperty(handler, "routeId", { value: id });
  return handler;
}

/** One built-in per ported id. */
function handlersFor(ids) {
  return new Map(ids.map((id) => [id, stub(id)]));
}

function build({ routePolicy = policy, portedRouteIds = REQUIRED, handlers } = {}) {
  return createProductionRouteRegistry({
    routePolicy,
    portedRouteIds,
    handlers: handlers ?? handlersFor(Array.isArray(portedRouteIds) ? portedRouteIds : []),
  });
}

function refused(work, code, label) {
  assert.ok(PRODUCTION_ROUTE_REGISTRY_CODES.includes(code), `${code} is a listed code`);
  assert.throws(work, (error) => {
    assert.ok(error instanceof TypeError, label);
    assert.equal(error.code, code, label);
    assert.equal(error.message, code, label);
    return true;
  }, label ?? code);
  observedCodes.add(code);
}

function policySha256(routePolicy) {
  const canonical = JSON.stringify(routePolicy.map((route) =>
    [route.id, route.pathname, route.methods === "all" ? "all" : [...route.methods], route.authority]));
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// The pinned table

test("the table is the d43c8f92 policy plus two owner-decided routes: 53 routes in Worker order, one class each", () => {
  assert.equal(policy.length, 53);
  assert.equal(PRODUCTION_ROUTE_PARITY_BASIS.commit, "d43c8f92");
  assert.deepEqual(Object.keys(PRODUCTION_ROUTE_PARITY_BASIS), ["commit", "ownerDecidedRouteIds", "routeCount",
    "policySha256"]);
  assert.deepEqual([...PRODUCTION_ROUTE_PARITY_BASIS.ownerDecidedRouteIds], [...OWNER_DECIDED_2026_10_10]);
  assert.ok(Object.isFrozen(PRODUCTION_ROUTE_PARITY_BASIS.ownerDecidedRouteIds));
  assert.equal(PRODUCTION_ROUTE_PARITY_BASIS.routeCount, 53);
  assert.equal(policySha256(policy), PRODUCTION_ROUTE_PARITY_BASIS.policySha256,
    "src/route-registry.ts changed: re-derive the table from the new parity basis (OD-CR-9)");
  // Without the owner-decided routes the policy is still d43c8f92's, byte for byte and in order.
  const d43c8f92 = policy.filter((route) => !OWNER_DECIDED_2026_10_10.includes(route.id));
  assert.equal(d43c8f92.length, 51);
  assert.equal(policySha256(d43c8f92), D43C8F92_POLICY_SHA256);
  assert.deepEqual(OWNER_DECIDED_2026_10_10.map((id) => policy.findIndex((route) => route.id === id)), [24, 52]);
  assert.equal(policy[23].id, "admin_action");
  assert.equal(policy[51].id, "community_daily");
  assert.equal(PRODUCTION_ROUTE_TABLE.length, 53);
  PRODUCTION_ROUTE_TABLE.forEach((route, index) => {
    assert.equal(route.workerOrder, index + 1);
    assert.equal(route.id, policy[index].id);
    assert.ok(Object.values(PRODUCTION_ROUTE_CLASSES).includes(route.routeClass), route.id);
    assert.deepEqual(Object.keys(route), ["workerOrder", "id", "routeClass"]);
    assert.ok(Object.isFrozen(route));
  });
  assert.ok(Object.isFrozen(PRODUCTION_ROUTE_TABLE));
  const count = (routeClass) => PRODUCTION_ROUTE_TABLE.filter((route) => route.routeClass === routeClass).length;
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.SCOPE), 21);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.OD_CR_1), 9);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.ADMIN), 7);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.PERFORMANCE), 4);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.RETIRED), 10);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.ROOT), 2);
  // Every round-12 question is answered: no route is left undecided, and
  // decision 1 (2026-10-10) moved the round-19 grant into the performance class.
  assert.deepEqual(Object.values(PRODUCTION_ROUTE_CLASSES).sort(),
    ["admin", "od-cr-1", "performance", "retired", "root", "scope"]);
  assert.deepEqual(Object.values(ORIGIN_ROUTE_DISPOSITIONS).sort(), ["ported", "root", "unported"]);
});

test("the class lists match the brief and the production ported list", () => {
  assert.deepEqual([...POSTGRES_SCOPE_ROUTE_IDS].sort(), [...BRIEF_SCOPE].sort());
  assert.deepEqual([...OD_CR_1_CONTESTED_ROUTE_IDS].sort(), [...BRIEF_CONTESTED].sort());
  assert.deepEqual([...ORIGIN_ROOT_ROUTE_IDS], ["apple_domain_association", "sparkle_appcast_guard"]);
  const all = new Set([...POSTGRES_SCOPE_ROUTE_IDS, ...OD_CR_1_CONTESTED_ROUTE_IDS,
    ...ADMIN_HOST_ROUTE_IDS, ...PERFORMANCE_ROUTE_IDS, ...RETIRED_ROUTE_IDS, ...ORIGIN_ROOT_ROUTE_IDS]);
  assert.equal(all.size, 53, "the six classes are disjoint and cover the policy");
  // The production list (src/backend-composition.ts, OD-CR-1: all nine;
  // decision 1: the performance intake; decision 7: the public model-performance
  // read) is scope, the contested routes and performance, in Worker order;
  // the edge-test and loopback origins serve exactly this list too.
  assert.equal(productionPortedRouteIds.length, 34);
  assert.deepEqual([...productionPortedRouteIds],
    policy.map((route) => route.id).filter((id) => POSTGRES_SCOPE_ROUTE_IDS.includes(id)
      || OD_CR_1_CONTESTED_ROUTE_IDS.includes(id) || PERFORMANCE_ROUTE_IDS.includes(id)));
  // OD-CR-2: the admin class is the policy's admin authority, as composition names it.
  const admin = policy.filter((route) => route.authority === "admin").map((route) => route.id);
  assert.deepEqual([...ADMIN_HOST_ROUTE_IDS], admin);
  assert.deepEqual([...productionAdminRouteIds], admin);
  assert.ok(ADMIN_HOST_ROUTE_IDS.includes("admin_performance_intake"));
  // Round 12's standing retirements and the performance class (decision 1's
  // intake and the public read), exactly.
  assert.deepEqual([...RETIRED_ROUTE_IDS].sort(), [...ROUND_12_RETIRED].sort());
  assert.deepEqual([...PERFORMANCE_ROUTE_IDS], [...DECISION_1_PERFORMANCE, "community_model_performance"]);
  assert.ok(Object.isFrozen(PERFORMANCE_ROUTE_IDS));
  // Round 12 keeps credential renew, disconnect and every OD-CR-1 session-authority port.
  for (const id of ["device_credential_renew", "device_disconnect", "session", "logout", "device_pairing",
    "device_pairing_claim", "participant_devices", "participant_device_revocation", "telemetry_v12_consent"]) {
    assert.ok(OD_CR_1_CONTESTED_ROUTE_IDS.includes(id), id);
    assert.ok(productionPortedRouteIds.includes(id), id);
  }
});

test("the performance class is the family's three routes and the public read; consent stays retired", () => {
  // The registry class is the performance family's (routes/performance-
  // telemetry.mjs) ids and pathnames plus the public read, whose pathname is
  // the analytics-v2 route's; each pathname is the policy's.
  assert.deepEqual([...PERFORMANCE_TELEMETRY_ROUTE_IDS],
    PERFORMANCE_ROUTE_IDS.filter((id) => id !== "community_model_performance"));
  for (const id of PERFORMANCE_TELEMETRY_ROUTE_IDS) {
    const route = policy.find((entry) => entry.id === id);
    assert.equal(PERFORMANCE_TELEMETRY_PATHNAMES[id], route.pathname, id);
    assert.equal(matchWorkerRoute(route.pathname).id, id, id);
  }
  const read = policy.find((entry) => entry.id === "community_model_performance");
  assert.equal(read.pathname, communityModelPerformancePath);
  assert.deepEqual([...read.methods], ["GET"]);
  assert.equal(read.authority, "public");
  assert.equal(matchWorkerRoute(communityModelPerformancePath).id, "community_model_performance");
  // The signed-in consent route is not the family's and stays retired.
  assert.ok(RETIRED_ROUTE_IDS.includes("telemetry_performance_consent"));
  assert.equal(Object.hasOwn(PERFORMANCE_TELEMETRY_PATHNAMES, "telemetry_performance_consent"), false);
  // No performance route consumes identity-link state.
  for (const id of PERFORMANCE_ROUTE_IDS) assert.equal(IDENTITY_LINK_CONSUMER_ROUTE_IDS.includes(id), false, id);
});

test("online erasure is retired: no policy route, DELETE /api/v1/me is unknown_api", () => {
  assert.equal(RETIRED_ONLINE_ERASURE_SURFACES.length, 2);
  assert.ok(Object.isFrozen(RETIRED_ONLINE_ERASURE_SURFACES));
  assert.equal(policy.some((route) => route.pathname === "/api/v1/me"), false);
  assert.equal(matchWorkerRoute("/api/v1/me").kind, "unknown_api");
  const adminAction = RETIRED_ONLINE_ERASURE_SURFACES.find((surface) => surface.routeId === "admin_action");
  assert.ok(adminAction !== undefined);
  // admin_action is the C-ADMIN port, served on the admin host only; its
  // participantErasure task is closed there (CLOSED_RUN_MAINTENANCE_TASK_KEYS).
  assert.ok(ADMIN_HOST_ROUTE_IDS.includes("admin_action"));
  // No route id or pathname names erasure or deletion.
  for (const route of policy) assert.doesNotMatch(`${route.id} ${route.pathname}`, /eras|delet/iu);
});

// ---------------------------------------------------------------------------
// The injected ported set (OD-CR-1)

function assertCoverage(registry, portedIds) {
  assert.equal(registry.coverage, "complete");
  assert.ok(Object.isFrozen(registry));
  assert.ok(isProductionRouteRegistry(registry));
  assert.equal(registry.routePolicy, policy);
  assert.deepEqual(registry.parityBasis, PRODUCTION_ROUTE_PARITY_BASIS);
  const portedSet = new Set(portedIds);
  assert.deepEqual([...registry.portedRouteIds],
    policy.filter((route) => portedSet.has(route.id)).map((route) => route.id), "Worker order");
  assert.deepEqual([...registry.portedPathnames],
    policy.filter((route) => portedSet.has(route.id)).map((route) => route.pathname));
  assert.deepEqual([...registry.rootRouteIds], [...ORIGIN_ROOT_ROUTE_IDS]);
  const expectedUnported = policy
    .map((route) => route.id)
    .filter((id) => !portedSet.has(id) && !ORIGIN_ROOT_ROUTE_IDS.includes(id))
    .sort();
  assert.deepEqual([...registry.unportedRouteIds], expectedUnported, "sorted");
  assert.deepEqual(Object.keys(registry), ["routePolicy", "parityBasis", "portedRouteIds", "portedPathnames",
    "unportedRouteIds", "rootRouteIds", "coverage", "resolve"], "ported, unported and root only");
  assert.equal(registry.portedRouteIds.length + registry.unportedRouteIds.length + registry.rootRouteIds.length, 53);
  for (const route of policy) {
    const resolved = registry.resolve(route.id);
    assert.ok(Object.isFrozen(resolved));
    assert.deepEqual(Object.keys(resolved), ["disposition", "handler"]);
    if (ORIGIN_ROOT_ROUTE_IDS.includes(route.id)) {
      assert.equal(resolved.disposition, ORIGIN_ROUTE_DISPOSITIONS.ROOT, route.id);
      assert.equal(resolved.handler, null);
    } else if (portedSet.has(route.id)) {
      assert.equal(resolved.disposition, ORIGIN_ROUTE_DISPOSITIONS.PORTED, route.id);
      assert.equal(resolved.handler.routeId, route.id);
    } else {
      assert.equal(resolved.disposition, ORIGIN_ROUTE_DISPOSITIONS.UNPORTED, route.id);
      assert.equal(resolved.handler, null);
    }
  }
}

test("scope and performance only (OD-CR-1 answers none): 25 ported, 26 unported, 2 root", () => {
  const registry = build();
  assertCoverage(registry, REQUIRED);
  assert.equal(registry.portedRouteIds.length, 25);
  assert.equal(registry.unportedRouteIds.length, 26);
  for (const id of OD_CR_1_CONTESTED_ROUTE_IDS) {
    assert.equal(registry.resolve(id).disposition, "unported", id);
  }
  for (const id of PERFORMANCE_ROUTE_IDS) assert.equal(registry.resolve(id).disposition, "ported", id);
});

test("the production list (scope 21, contested 9, performance 4): 34 ported, 17 unported, 2 root", () => {
  const registry = build({ portedRouteIds: productionPortedRouteIds });
  assertCoverage(registry, productionPortedRouteIds);
  assert.equal(registry.portedRouteIds.length, 34);
  assert.deepEqual([...registry.unportedRouteIds],
    [...ADMIN_HOST_ROUTE_IDS, ...RETIRED_ROUTE_IDS].sort());
});

test("an open admin host (round 12) adds the seven admin routes: 41 ported, 10 retired, 2 root", () => {
  const ported = [...productionPortedRouteIds, ...ADMIN_HOST_ROUTE_IDS];
  const registry = build({ portedRouteIds: ported });
  assertCoverage(registry, ported);
  assert.equal(registry.portedRouteIds.length, 41);
  assert.equal(registry.resolve("admin_performance_intake").handler.routeId, "admin_performance_intake");
  assert.deepEqual([...registry.unportedRouteIds], [...RETIRED_ROUTE_IDS].sort());
  const grant = registry.resolve("accountless_telemetry_performance_authorization");
  assert.deepEqual([grant.disposition, grant.handler.routeId],
    ["ported", "accountless_telemetry_performance_authorization"]);
});

test("scope and performance plus any single contested route, in any order of the injected list", () => {
  for (const contested of OD_CR_1_CONTESTED_ROUTE_IDS) {
    const ported = [contested, ...[...REQUIRED].reverse()];
    assertCoverage(build({ portedRouteIds: ported }), ported);
  }
});

test("the handler map is a snapshot; the injected list order never changes Worker order", () => {
  const handlers = handlersFor(REQUIRED);
  const registry = createProductionRouteRegistry({ routePolicy: policy, portedRouteIds: REQUIRED, handlers });
  const original = registry.resolve("health").handler;
  handlers.set("health", stub("replaced"));
  handlers.delete("ready");
  handlers.set("enroll", stub("enroll"));
  assert.equal(registry.resolve("health").handler, original);
  assert.equal(registry.resolve("ready").disposition, "ported");
  assert.equal(registry.resolve("enroll").disposition, "unported");
});

test("only issued registries are registries", () => {
  const registry = build();
  assert.equal(isProductionRouteRegistry(registry), true);
  assert.equal(isProductionRouteRegistry({ ...registry }), false);
  assert.equal(isProductionRouteRegistry(Object.freeze({ ...registry })), false);
  assert.equal(isProductionRouteRegistry(null), false);
  assert.equal(isProductionRouteRegistry(undefined), false);
});

// ---------------------------------------------------------------------------
// Closed refusals

test("PRODUCTION_ROUTE_COVERAGE_INCOMPLETE: 52 or 54 routes, duplicates, malformed entries", () => {
  refused(() => build({ routePolicy: policy.slice(0, 52) }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "52 routes");
  // d43c8f92's 51 routes without the owner-decided ones are no longer the basis either.
  refused(() => build({ routePolicy: policy.filter((route) => !OWNER_DECIDED_2026_10_10.includes(route.id)) }),
    "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "the bare d43c8f92 policy");
  refused(() => build({ routePolicy: policy.slice(1) }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "first route dropped");
  refused(() => build({ routePolicy: [...policy, Object.freeze({
    pathname: "/api/v1/synthetic", id: "synthetic", methods: Object.freeze(["GET"]), authority: "public",
  })] }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "54 routes");
  const duplicateId = policy.map((route, index) => index === 4 ? { ...route, id: policy[3].id } : route);
  refused(() => build({ routePolicy: duplicateId }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "duplicate id");
  const duplicatePath = policy.map((route, index) => index === 4 ? { ...route, pathname: policy[3].pathname } : route);
  refused(() => build({ routePolicy: duplicatePath }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "duplicate pathname");
  const badMethod = policy.map((route, index) => index === 1 ? { ...route, methods: ["PUT"] } : route);
  refused(() => build({ routePolicy: badMethod }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "unknown method");
  const relative = policy.map((route, index) => index === 1 ? { ...route, pathname: "api/health" } : route);
  refused(() => build({ routePolicy: relative }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "relative pathname");
  for (const routePolicy of [undefined, null, {}, "routes", policy.map(() => null)]) {
    refused(() => createProductionRouteRegistry({
      routePolicy, portedRouteIds: REQUIRED, handlers: handlersFor(REQUIRED),
    }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", String(routePolicy));
  }
  refused(() => createProductionRouteRegistry(), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "no arguments");
  // A ported id outside the policy (a pathname, a made-up id) is not coverage.
  for (const id of [EFFECTIVE_PAGE_PATH, "telemetry_v12_effective_page", "unknown_api", "asset"]) {
    refused(() => build({ portedRouteIds: [...REQUIRED, id] }),
      "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", id);
  }
});

test("PRODUCTION_ROUTE_PARITY_BASIS_DRIFT: 53 routes but not the pinned ones in the pinned order", () => {
  const swapped = [...policy];
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  refused(() => build({ routePolicy: swapped }), "PRODUCTION_ROUTE_PARITY_BASIS_DRIFT", "reordered");
  const renamed = policy.map((route, index) => index === 50 ? { ...route, id: "community_daily_v2" } : route);
  refused(() => build({ routePolicy: renamed }), "PRODUCTION_ROUTE_PARITY_BASIS_DRIFT", "renamed");
  // The owner-decided routes keep their pinned positions.
  const moved = [...policy];
  [moved[51], moved[52]] = [moved[52], moved[51]];
  refused(() => build({ routePolicy: moved }), "PRODUCTION_ROUTE_PARITY_BASIS_DRIFT", "owner-decided route moved");
});

test("PRODUCTION_ROUTE_PORTED_SET_INVALID: the ported set is required, a list of distinct ids", () => {
  for (const portedRouteIds of [undefined, null, "health", new Set(REQUIRED),
    [...REQUIRED, "health"], [...REQUIRED, 7]]) {
    refused(() => createProductionRouteRegistry({
      routePolicy: policy, portedRouteIds, handlers: handlersFor(REQUIRED),
    }), "PRODUCTION_ROUTE_PORTED_SET_INVALID", String(portedRouteIds));
  }
  refused(() => createProductionRouteRegistry({ routePolicy: policy, handlers: new Map() }),
    "PRODUCTION_ROUTE_PORTED_SET_INVALID", "no OD-CR-1 answer, no default");
});

test("PRODUCTION_ROUTE_ROOT_CLAIMED: a root route ported or given a handler", () => {
  for (const root of ORIGIN_ROOT_ROUTE_IDS) {
    refused(() => build({ portedRouteIds: [...REQUIRED, root] }),
      "PRODUCTION_ROUTE_ROOT_CLAIMED", `${root} ported`);
    const handlers = handlersFor(REQUIRED);
    handlers.set(root, stub(root));
    refused(() => build({ handlers }), "PRODUCTION_ROUTE_ROOT_CLAIMED", `${root} handler`);
  }
});

test("PRODUCTION_ROUTE_PORT_RETIRED: no round-12 retired route can be ported", () => {
  assert.equal(RETIRED_ROUTE_IDS.length, 10);
  for (const id of RETIRED_ROUTE_IDS) {
    refused(() => build({ portedRouteIds: [...REQUIRED, id] }),
      "PRODUCTION_ROUTE_PORT_RETIRED", id);
  }
  // A handler offered for a 503-retired route is refused too, even without
  // porting it.
  for (const id of RETIRED_ROUTE_IDS) {
    const handlers = handlersFor(REQUIRED);
    handlers.set(id, stub(id));
    refused(() => build({ handlers }), "PRODUCTION_ROUTE_HANDLER_UNEXPECTED", `${id} handler`);
  }
});

test("IDENTITY_LINK_ROTATION_CONSUMER_PORTED: every identity-link consumer stays retired and unported", () => {
  // Round 16 rotates the lost IDENTITY_LINK_SECRET only because round 12
  // retires every route that reads its pin, link keys or cooldown digests.
  assert.deepEqual([...IDENTITY_LINK_CONSUMER_ROUTE_IDS], ["enroll", "identity_google_start",
    "identity_google_callback", "identity_google_result", "identity_apple_start", "identity_apple_callback",
    "identity_apple_result", "security_reset", "participant_export"]);
  for (const id of IDENTITY_LINK_CONSUMER_ROUTE_IDS) assert.ok(RETIRED_ROUTE_IDS.includes(id), id);
  // The production list (and an open admin host) ports none of them.
  assert.equal(assertIdentityLinkConsumersRetired([...productionPortedRouteIds]), 9);
  assert.equal(assertIdentityLinkConsumersRetired([...productionPortedRouteIds, ...ADMIN_HOST_ROUTE_IDS]), 9);
  for (const id of IDENTITY_LINK_CONSUMER_ROUTE_IDS) {
    refused(() => assertIdentityLinkConsumersRetired([...productionPortedRouteIds, id]),
      "IDENTITY_LINK_ROTATION_CONSUMER_PORTED", id);
  }
  refused(() => assertIdentityLinkConsumersRetired(null), "IDENTITY_LINK_ROTATION_CONSUMER_PORTED", "not a list");
  refused(() => assertIdentityLinkConsumersRetired([1]), "IDENTITY_LINK_ROTATION_CONSUMER_PORTED", "not ids");
});

test("PRODUCTION_ROUTE_SCOPE_INCOMPLETE: every scope route and every performance route is required", () => {
  for (const id of REQUIRED) {
    const ported = [...REQUIRED.filter((required) => required !== id), ...OD_CR_1_CONTESTED_ROUTE_IDS];
    refused(() => build({ portedRouteIds: ported }), "PRODUCTION_ROUTE_SCOPE_INCOMPLETE", id);
  }
  // Scope alone (the pre-decision-1 minimum) no longer composes.
  refused(() => build({ portedRouteIds: [...POSTGRES_SCOPE_ROUTE_IDS] }), "PRODUCTION_ROUTE_SCOPE_INCOMPLETE",
    "performance absent");
  refused(() => build({ portedRouteIds: [] }), "PRODUCTION_ROUTE_SCOPE_INCOMPLETE", "empty");
});

test("PRODUCTION_ROUTE_HANDLERS_INVALID: handlers must be a Map", () => {
  for (const handlers of [null, {}, Object.fromEntries(handlersFor(REQUIRED)),
    [...handlersFor(REQUIRED)]]) {
    refused(() => createProductionRouteRegistry({
      routePolicy: policy, portedRouteIds: REQUIRED, handlers,
    }), "PRODUCTION_ROUTE_HANDLERS_INVALID", String(handlers));
  }
  refused(() => createProductionRouteRegistry({ routePolicy: policy, portedRouteIds: REQUIRED }),
    "PRODUCTION_ROUTE_HANDLERS_INVALID", "missing");
});

test("PRODUCTION_ROUTE_HANDLER_UNEXPECTED: a handler outside the ported set", () => {
  const extraKeys = [
    ...RETIRED_ROUTE_IDS,
    ...OD_CR_1_CONTESTED_ROUTE_IDS,
    ...ADMIN_HOST_ROUTE_IDS,
    EFFECTIVE_PAGE_PATH,
    "/api/health",
    "unknown_api",
    "asset",
  ];
  for (const key of extraKeys) {
    const handlers = handlersFor(REQUIRED);
    handlers.set(key, stub(key));
    refused(() => build({ handlers }), "PRODUCTION_ROUTE_HANDLER_UNEXPECTED", key);
  }
});

test("PRODUCTION_ROUTE_HANDLER_MISSING: every ported id has a function", () => {
  const ported = [...REQUIRED, ...OD_CR_1_CONTESTED_ROUTE_IDS];
  for (const id of ported) {
    const handlers = handlersFor(ported);
    handlers.delete(id);
    refused(() => build({ portedRouteIds: ported, handlers }), "PRODUCTION_ROUTE_HANDLER_MISSING", `${id} absent`);
    handlers.set(id, { fetch: stub(id) });
    refused(() => build({ portedRouteIds: ported, handlers }), "PRODUCTION_ROUTE_HANDLER_MISSING", `${id} not a function`);
  }
});

// ---------------------------------------------------------------------------
// One registry: the route modules fold into the ported handlers

const DAILY = "/api/v1/community/daily";
const UPLOAD_AUTHORIZATIONS = "/api/v1/device/upload-authorizations";

function modulesFor(entries) {
  return createOriginRouteModuleRegistry({
    routePolicy: policy,
    modules: entries.map(([method, pathname, body]) => defineOriginRouteModule({
      method, pathname, overridesBuiltIn: true,
      handler: async (_request, context) => new Response(JSON.stringify({ body, context }), { status: 200 }),
    })),
  });
}

test("route modules fold into the registry: the module for the method, else the built-in", async () => {
  const contexts = [];
  const registry = createProductionRouteRegistry({
    routePolicy: policy,
    portedRouteIds: productionPortedRouteIds,
    handlers: handlersFor(productionPortedRouteIds),
    routeModules: modulesFor([["GET", DAILY, "daily-module"], ["POST", UPLOAD_AUTHORIZATIONS, "upload-module"]]),
    routeModuleContext: (request) => {
      contexts.push(request);
      return Object.freeze({ origin: "https://tibotattle.test", hostMode: "synthetic", requestId: "id" });
    },
  });
  const daily = new Request(`https://tibotattle.test${DAILY}?from=2026-10-01&to=2026-10-01`);
  const served = await registry.resolve("community_daily").handler(daily);
  assert.deepEqual(await served.json(), {
    body: "daily-module", context: { origin: "https://tibotattle.test", hostMode: "synthetic", requestId: "id" },
  });
  assert.deepEqual(contexts, [daily]);
  const upload = await registry.resolve("device_upload_authorization").handler(
    new Request(`https://tibotattle.test${UPLOAD_AUTHORIZATIONS}`, { method: "POST", body: "{}" }));
  assert.equal((await upload.json()).body, "upload-module");
  // No module for this method: the built-in answers; a route without a module is untouched.
  const builtIn = await registry.resolve("community_daily").handler(
    new Request(`https://tibotattle.test${DAILY}`, { method: "POST", body: "{}" }));
  assert.equal(await builtIn.text(), "community_daily");
  assert.equal(registry.resolve("contributions").handler.routeId, "contributions");
  // Each module call built its context once; the built-in answer built none.
  assert.equal(contexts.length, 2);
});

test("PRODUCTION_ROUTE_MODULES_INVALID and a module for an unported route", () => {
  const modules = modulesFor([["GET", DAILY, "daily-module"]]);
  for (const [routeModules, routeModuleContext] of [
    [{ pathnames: [DAILY], size: 1, resolve: () => null }, () => ({})],
    [Object.freeze({ ...modules }), () => ({})],
    [modules, undefined],
    [modules, {}],
    [null, () => ({})],
  ]) {
    refused(() => createProductionRouteRegistry({
      routePolicy: policy, portedRouteIds: productionPortedRouteIds,
      handlers: handlersFor(productionPortedRouteIds), routeModules, routeModuleContext,
    }), "PRODUCTION_ROUTE_MODULES_INVALID");
  }
  // The scope always ports both overridable built-ins, so a module can only
  // reach an unported route through a policy that is not the pinned one;
  // the registry still refuses it on its own pathname check.
  refused(() => createProductionRouteRegistry({
    routePolicy: policy, portedRouteIds: productionPortedRouteIds,
    handlers: handlersFor(productionPortedRouteIds),
    routeModules: Object.assign(Object.create(null), modules),
    routeModuleContext: () => ({}),
  }), "PRODUCTION_ROUTE_MODULES_INVALID", "a copy is not an issued module registry");
});

test("PRODUCTION_ROUTE_UNKNOWN: resolve answers only policy ids", () => {
  const registry = build();
  for (const id of [EFFECTIVE_PAGE_PATH, "unknown_api", "asset", "", undefined, null, 1]) {
    refused(() => registry.resolve(id), "PRODUCTION_ROUTE_UNKNOWN", String(id));
  }
});

test("every listed refusal code is exercised", () => {
  assert.deepEqual([...observedCodes].sort(), [...PRODUCTION_ROUTE_REGISTRY_CODES].sort());
});
