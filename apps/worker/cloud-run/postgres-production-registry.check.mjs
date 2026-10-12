import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  POSTGRES_SCOPE_ROUTE_IDS,
  PRODUCTION_ROUTE_CLASSES,
  PRODUCTION_ROUTE_PARITY_BASIS,
  PRODUCTION_ROUTE_REGISTRY_CODES,
  PRODUCTION_ROUTE_TABLE,
  RETIRED_DEFINITE_PREAMBLE_STEPS,
  RETIRED_DEFINITE_ROUTE_IDS,
  RETIRED_ONLINE_ERASURE_SURFACES,
  RETIRED_ROUTE_DEFINITE_ANSWERS,
  RETIRED_ROUTE_IDS,
  assertIdentityLinkConsumersRetired,
  createProductionRouteRegistry,
  isProductionRouteRegistry,
} from "./postgres-production-registry.mjs";
import { createOriginRouteModuleRegistry, defineOriginRouteModule } from "./origin-route-modules.mjs";

// CR-6 registry without a database: the pinned d43c8f92 route table against
// the Worker's own WORKER_ROUTE_POLICY, the injected ported set (scope, the
// OD-CR-1 contested routes and the OD-CR-2 admin routes), the round-12
// retired routes (the uniform 503, and the one retired-definite route whose
// preamble round 19 requires), the production
// list in src/backend-composition.ts, the route-module fold (one registry)
// and every closed refusal. Every handler is a synthetic stub.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let vite;
let policy;
let matchWorkerRoute;
let productionPortedRouteIds;
let productionAdminRouteIds;

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
/** Owner round 12 (2026-10-02): retired at the switch, listed independently of the table. */
const ROUND_12_RETIRED = Object.freeze([
  "enroll", "identity_google_start", "identity_google_callback", "identity_google_result", "identity_apple_start",
  "identity_apple_callback", "identity_apple_result", "security_reset", "participant_export",
  "telemetry_performance_capabilities", "telemetry_performance_consent", "telemetry_performance_reports",
]);
/** Round 12: production's definite answer, read from d43c8f92 (telemetry-performance-policy.ts invalid()). */
const ROUND_12_DEFINITE = Object.freeze({
  accountless_telemetry_performance_authorization: { status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" },
});
const EFFECTIVE_PAGE_PATH = "/api/v1/me/telemetry-v12/effective-page";

const observedCodes = new Set();

function stub(id) {
  const handler = async () => new Response(id, { status: 200 });
  Object.defineProperty(handler, "routeId", { value: id });
  return handler;
}

/** The ported ids' built-ins plus every retired-definite preamble (round 19). */
function handlersFor(ids) {
  return new Map([...ids, ...RETIRED_DEFINITE_ROUTE_IDS].map((id) => [id, stub(id)]));
}

function build({ routePolicy = policy, portedRouteIds = POSTGRES_SCOPE_ROUTE_IDS, handlers } = {}) {
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

test("the table is the d43c8f92 policy: 51 routes in Worker order, one class each", () => {
  assert.equal(policy.length, 51);
  assert.equal(PRODUCTION_ROUTE_PARITY_BASIS.commit, "d43c8f92");
  assert.equal(PRODUCTION_ROUTE_PARITY_BASIS.routeCount, 51);
  assert.equal(policySha256(policy), PRODUCTION_ROUTE_PARITY_BASIS.policySha256,
    "src/route-registry.ts changed: re-derive the table from the new parity basis (OD-CR-9)");
  assert.equal(PRODUCTION_ROUTE_TABLE.length, 51);
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
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.ADMIN), 6);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.RETIRED), 12);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.RETIRED_DEFINITE), 1);
  assert.equal(count(PRODUCTION_ROUTE_CLASSES.ROOT), 2);
  // Every round-12 question is answered: no route is left undecided.
  assert.deepEqual(Object.values(PRODUCTION_ROUTE_CLASSES).sort(),
    ["admin", "od-cr-1", "retired", "retired-definite", "root", "scope"]);
});

test("the class lists match the brief and the production ported list", () => {
  assert.deepEqual([...POSTGRES_SCOPE_ROUTE_IDS].sort(), [...BRIEF_SCOPE].sort());
  assert.deepEqual([...OD_CR_1_CONTESTED_ROUTE_IDS].sort(), [...BRIEF_CONTESTED].sort());
  assert.deepEqual([...ORIGIN_ROOT_ROUTE_IDS], ["apple_domain_association", "sparkle_appcast_guard"]);
  const all = new Set([...POSTGRES_SCOPE_ROUTE_IDS, ...OD_CR_1_CONTESTED_ROUTE_IDS,
    ...ADMIN_HOST_ROUTE_IDS, ...RETIRED_ROUTE_IDS, ...RETIRED_DEFINITE_ROUTE_IDS, ...ORIGIN_ROOT_ROUTE_IDS]);
  assert.equal(all.size, 51, "the six classes are disjoint and cover the policy");
  // The production list (src/backend-composition.ts, OD-CR-1: all nine) is
  // scope plus the contested routes, in Worker order; the edge-test and
  // loopback origins serve exactly this list too.
  assert.deepEqual([...productionPortedRouteIds],
    policy.map((route) => route.id).filter((id) =>
      POSTGRES_SCOPE_ROUTE_IDS.includes(id) || OD_CR_1_CONTESTED_ROUTE_IDS.includes(id)));
  // OD-CR-2: the admin class is the policy's admin authority, as composition names it.
  const admin = policy.filter((route) => route.authority === "admin").map((route) => route.id);
  assert.deepEqual([...ADMIN_HOST_ROUTE_IDS], admin);
  assert.deepEqual([...productionAdminRouteIds], admin);
  // Round 12: the retired routes and the one definite answer, exactly.
  assert.deepEqual([...RETIRED_ROUTE_IDS].sort(), [...ROUND_12_RETIRED].sort());
  assert.deepEqual([...RETIRED_DEFINITE_ROUTE_IDS], Object.keys(ROUND_12_DEFINITE));
  assert.deepEqual(JSON.parse(JSON.stringify(RETIRED_ROUTE_DEFINITE_ANSWERS)), ROUND_12_DEFINITE);
  assert.deepEqual(Object.keys(RETIRED_ROUTE_DEFINITE_ANSWERS), [...RETIRED_DEFINITE_ROUTE_IDS]);
  assert.ok(Object.isFrozen(RETIRED_ROUTE_DEFINITE_ANSWERS));
  for (const answer of Object.values(RETIRED_ROUTE_DEFINITE_ANSWERS)) {
    assert.ok(Object.isFrozen(answer));
    assert.ok(answer.status >= 400 && answer.status < 500, "a definite answer is a 4xx, never retryable");
  }
  // Round 12 keeps credential renew, disconnect and every OD-CR-1 session-authority port.
  for (const id of ["device_credential_renew", "device_disconnect", "session", "logout", "device_pairing",
    "device_pairing_claim", "participant_devices", "participant_device_revocation", "telemetry_v12_consent"]) {
    assert.ok(OD_CR_1_CONTESTED_ROUTE_IDS.includes(id), id);
    assert.ok(productionPortedRouteIds.includes(id), id);
  }
});

test("round 12: the definite answer is production's d43c8f92 code for the route", async (t) => {
  // The Worker grants the accountless performance authorization only while
  // telemetry_performance_runtime is 'active'; ingestion-isolation 0009 seeds
  // it 'staged', so the grant's owner query finds no row and answers its
  // invalid(): 403 TELEMETRY_TRANSPORT_BLOCKED. Read from the parity basis.
  const git = (args) => new Promise((resolveGit, rejectGit) => {
    execFile("git", args, { cwd: WORKER_ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? rejectGit(error) : resolveGit(stdout)));
  });
  const basis = PRODUCTION_ROUTE_PARITY_BASIS.commit;
  try {
    await git(["cat-file", "-e", `${basis}^{commit}`]);
  } catch {
    // A checkout without the parity basis (a shallow clone) cannot prove the
    // answer from source: report a skip, never a pass.
    t.skip(`parity basis ${basis} unavailable in this checkout`);
    return;
  }
  // The basis is present, so every read must succeed: a missing file fails.
  const show = (path) => git(["show", `${basis}:${path}`]);
  const [policySource, migration, index] = await Promise.all([
    show("apps/worker/src/telemetry-performance-policy.ts"),
    show("apps/worker/ingestion-isolation-migrations/0009_performance_reports.sql"),
    show("apps/worker/src/index.ts"),
  ]);
  assert.ok(policySource.includes("export async function grantTelemetryPerformanceAccountlessAuthorization"));
  assert.match(policySource, /function invalid\(code: "TELEMETRY_TRANSPORT_BLOCKED"[^)]*= "TELEMETRY_TRANSPORT_BLOCKED"\): never \{\s*throw new ApiError\(403, code\);/u);
  const grant = policySource.slice(policySource.indexOf("export async function grantTelemetryPerformanceAccountlessAuthorization"));
  assert.match(grant, /AND r\.state = 'active'[\s\S]*?if \(!owner\) invalid\(\);/u);
  assert.match(migration, /INSERT INTO telemetry_performance_runtime[\s\S]*?'staged', 1,/u);
  assert.match(index, /case "accountless_telemetry_performance_authorization":\s*return handleAccountlessTelemetryPerformanceAuthorization\(request, env\);/u);
  assert.deepEqual(RETIRED_ROUTE_DEFINITE_ANSWERS.accountless_telemetry_performance_authorization,
    { status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" });
});

test("round 19: the retired-definite preamble steps are d43c8f92's, in handler order, closed and frozen", async (t) => {
  assert.deepEqual(Object.keys(RETIRED_DEFINITE_PREAMBLE_STEPS), [...RETIRED_DEFINITE_ROUTE_IDS]);
  assert.ok(Object.isFrozen(RETIRED_DEFINITE_PREAMBLE_STEPS));
  const steps = RETIRED_DEFINITE_PREAMBLE_STEPS.accountless_telemetry_performance_authorization;
  assert.ok(Object.isFrozen(steps) && steps.every((step) => Object.isFrozen(step)));
  assert.deepEqual([...new Set(steps.map(([step]) => step))], ["session_cookie", "storage", "ownership_mode",
    "admission_bindings", "upload_registration", "attempt_limit", "device_bearer", "body"]);
  // Every earlier answer differs from the terminal one, so a client can tell them apart.
  const terminal = RETIRED_ROUTE_DEFINITE_ANSWERS.accountless_telemetry_performance_authorization;
  for (const [, status, code] of steps) assert.notDeepEqual([status, code], [terminal.status, terminal.code]);
  const git = (args) => new Promise((resolveGit, rejectGit) => {
    execFile("git", args, { cwd: WORKER_ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? rejectGit(error) : resolveGit(stdout)));
  });
  const basis = PRODUCTION_ROUTE_PARITY_BASIS.commit;
  try {
    await git(["cat-file", "-e", `${basis}^{commit}`]);
  } catch {
    t.skip(`parity basis ${basis} unavailable in this checkout`);
    return;
  }
  // The handler's call order at the basis: the steps above, with the
  // storage-mode read the origin does not reproduce (round 19 amendment).
  const index = await git(["show", `${basis}:apps/worker/src/index.ts`]);
  const start = index.indexOf("async function handleAccountlessTelemetryPerformanceAuthorization(");
  const body = index.slice(start, index.indexOf("\n}\n", start));
  const calls = ["methodNotAllowed([\"POST\"])", "hasSessionCookie(", "assertAccountlessOwnershipEnabled(env)",
    "assertAdmissionBindings(env)", "assertCollectionControl(env.USAGE_MONITOR_DB, \"uploadRegistration\")",
    "\"accountless_ownership\"", "authenticateDevice(", "authorization.authorityKind !== \"accountless\"",
    "requireTelemetryPerformanceStorageMode(",
    "readBoundedAccountlessTelemetryPerformanceAuthorizationJson(request)",
    "grantTelemetryPerformanceAccountlessAuthorization("];
  const positions = calls.map((call) => body.indexOf(call));
  for (const [i, position] of positions.entries()) assert.ok(position > 0, calls[i]);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "d43c8f92 call order");
  assert.match(body, /throw new ApiError\(401, "AUTH_INVALID"\)[\s\S]*throw new ApiError\(401, "DEVICE_AUTH_INVALID"\)/u);
  // The body reader's answers are readBoundedJson's (415, 400, 413) plus the
  // closed shape's 400, and readBoundedRequestBody's 408.
  const reader = index.slice(index.indexOf("async function readBoundedAccountlessTelemetryPerformanceAuthorizationJson("));
  assert.match(reader, /await readBoundedJson\(request\)[\s\S]*?throw new ApiError\(400, "BODY_INVALID"\)/u);
  const json = index.slice(index.indexOf("async function readBoundedJson("));
  for (const answer of ["415, \"CONTENT_TYPE_INVALID\"", "400, \"BODY_INVALID\"", "413, \"BODY_TOO_LARGE\""]) {
    assert.ok(json.slice(0, json.indexOf("\n}\n")).includes(answer), answer);
  }
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
    .filter((id) => !portedSet.has(id) && !ORIGIN_ROOT_ROUTE_IDS.includes(id) && !RETIRED_DEFINITE_ROUTE_IDS.includes(id))
    .sort();
  assert.deepEqual([...registry.unportedRouteIds], expectedUnported, "sorted");
  assert.deepEqual([...registry.definiteRouteIds], [...RETIRED_DEFINITE_ROUTE_IDS]);
  assert.equal(registry.portedRouteIds.length + registry.unportedRouteIds.length + registry.definiteRouteIds.length
    + registry.rootRouteIds.length, 51);
  for (const route of policy) {
    const resolved = registry.resolve(route.id);
    assert.ok(Object.isFrozen(resolved));
    assert.deepEqual(Object.keys(resolved), ["disposition", "handler", "answer"]);
    if (ORIGIN_ROOT_ROUTE_IDS.includes(route.id)) {
      assert.equal(resolved.disposition, ORIGIN_ROUTE_DISPOSITIONS.ROOT, route.id);
      assert.equal(resolved.handler, null);
      assert.equal(resolved.answer, null);
    } else if (portedSet.has(route.id)) {
      assert.equal(resolved.disposition, ORIGIN_ROUTE_DISPOSITIONS.PORTED, route.id);
      assert.equal(resolved.handler.routeId, route.id);
      assert.equal(resolved.answer, null);
    } else if (RETIRED_DEFINITE_ROUTE_IDS.includes(route.id)) {
      // Round 19: its preamble, then the terminal answer.
      assert.equal(resolved.disposition, ORIGIN_ROUTE_DISPOSITIONS.DEFINITE, route.id);
      assert.equal(resolved.handler.routeId, route.id);
      assert.equal(resolved.answer, RETIRED_ROUTE_DEFINITE_ANSWERS[route.id]);
    } else {
      assert.equal(resolved.disposition, ORIGIN_ROUTE_DISPOSITIONS.UNPORTED, route.id);
      assert.equal(resolved.handler, null);
      assert.equal(resolved.answer, null);
    }
  }
}

test("scope only (OD-CR-1 answers none): 21 ported, 27 unported, 1 definite, 2 root", () => {
  const registry = build();
  assertCoverage(registry, POSTGRES_SCOPE_ROUTE_IDS);
  assert.equal(registry.portedRouteIds.length, 21);
  assert.equal(registry.unportedRouteIds.length, 27);
  for (const id of OD_CR_1_CONTESTED_ROUTE_IDS) {
    assert.equal(registry.resolve(id).disposition, "unported", id);
  }
});

test("the production list (scope plus all nine contested routes): 30 ported, 18 unported, 1 definite, 2 root", () => {
  const registry = build({ portedRouteIds: productionPortedRouteIds });
  assertCoverage(registry, productionPortedRouteIds);
  assert.equal(registry.portedRouteIds.length, 30);
  assert.deepEqual([...registry.unportedRouteIds],
    [...ADMIN_HOST_ROUTE_IDS, ...RETIRED_ROUTE_IDS].sort());
});

test("an open admin host (round 12) adds the six admin routes: 36 ported, 12 retired, 1 definite, 2 root", () => {
  const ported = [...productionPortedRouteIds, ...ADMIN_HOST_ROUTE_IDS];
  const registry = build({ portedRouteIds: ported });
  assertCoverage(registry, ported);
  assert.equal(registry.portedRouteIds.length, 36);
  assert.deepEqual([...registry.unportedRouteIds], [...RETIRED_ROUTE_IDS].sort());
  assert.deepEqual([...registry.definiteRouteIds], ["accountless_telemetry_performance_authorization"]);
  const definite = registry.resolve("accountless_telemetry_performance_authorization");
  assert.deepEqual([definite.disposition, definite.handler.routeId, definite.answer],
    ["definite", "accountless_telemetry_performance_authorization",
      RETIRED_ROUTE_DEFINITE_ANSWERS.accountless_telemetry_performance_authorization]);
  assert.deepEqual({ ...definite.answer }, ROUND_12_DEFINITE.accountless_telemetry_performance_authorization);
});

test("scope plus any single contested route, in any order of the injected list", () => {
  for (const contested of OD_CR_1_CONTESTED_ROUTE_IDS) {
    const ported = [contested, ...[...POSTGRES_SCOPE_ROUTE_IDS].reverse()];
    assertCoverage(build({ portedRouteIds: ported }), ported);
  }
});

test("the handler map is a snapshot; the injected list order never changes Worker order", () => {
  const handlers = handlersFor(POSTGRES_SCOPE_ROUTE_IDS);
  const registry = createProductionRouteRegistry({ routePolicy: policy, portedRouteIds: POSTGRES_SCOPE_ROUTE_IDS, handlers });
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

test("PRODUCTION_ROUTE_COVERAGE_INCOMPLETE: 50 or 52 routes, duplicates, malformed entries", () => {
  refused(() => build({ routePolicy: policy.slice(0, 50) }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "50 routes");
  refused(() => build({ routePolicy: policy.slice(1) }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "first route dropped");
  refused(() => build({ routePolicy: [...policy, Object.freeze({
    pathname: "/api/v1/synthetic", id: "synthetic", methods: Object.freeze(["GET"]), authority: "public",
  })] }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "52 routes");
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
      routePolicy, portedRouteIds: POSTGRES_SCOPE_ROUTE_IDS, handlers: handlersFor(POSTGRES_SCOPE_ROUTE_IDS),
    }), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", String(routePolicy));
  }
  refused(() => createProductionRouteRegistry(), "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", "no arguments");
  // A ported id outside the policy (a pathname, a made-up id) is not coverage.
  for (const id of [EFFECTIVE_PAGE_PATH, "telemetry_v12_effective_page", "unknown_api", "asset"]) {
    refused(() => build({ portedRouteIds: [...POSTGRES_SCOPE_ROUTE_IDS, id] }),
      "PRODUCTION_ROUTE_COVERAGE_INCOMPLETE", id);
  }
});

test("PRODUCTION_ROUTE_PARITY_BASIS_DRIFT: 51 routes but not the pinned ones in the pinned order", () => {
  const swapped = [...policy];
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  refused(() => build({ routePolicy: swapped }), "PRODUCTION_ROUTE_PARITY_BASIS_DRIFT", "reordered");
  const renamed = policy.map((route, index) => index === 50 ? { ...route, id: "community_daily_v2" } : route);
  refused(() => build({ routePolicy: renamed }), "PRODUCTION_ROUTE_PARITY_BASIS_DRIFT", "renamed");
});

test("PRODUCTION_ROUTE_PORTED_SET_INVALID: the ported set is required, a list of distinct ids", () => {
  for (const portedRouteIds of [undefined, null, "health", new Set(POSTGRES_SCOPE_ROUTE_IDS),
    [...POSTGRES_SCOPE_ROUTE_IDS, "health"], [...POSTGRES_SCOPE_ROUTE_IDS, 7]]) {
    refused(() => createProductionRouteRegistry({
      routePolicy: policy, portedRouteIds, handlers: handlersFor(POSTGRES_SCOPE_ROUTE_IDS),
    }), "PRODUCTION_ROUTE_PORTED_SET_INVALID", String(portedRouteIds));
  }
  refused(() => createProductionRouteRegistry({ routePolicy: policy, handlers: new Map() }),
    "PRODUCTION_ROUTE_PORTED_SET_INVALID", "no OD-CR-1 answer, no default");
});

test("PRODUCTION_ROUTE_ROOT_CLAIMED: a root route ported or given a handler", () => {
  for (const root of ORIGIN_ROOT_ROUTE_IDS) {
    refused(() => build({ portedRouteIds: [...POSTGRES_SCOPE_ROUTE_IDS, root] }),
      "PRODUCTION_ROUTE_ROOT_CLAIMED", `${root} ported`);
    const handlers = handlersFor(POSTGRES_SCOPE_ROUTE_IDS);
    handlers.set(root, stub(root));
    refused(() => build({ handlers }), "PRODUCTION_ROUTE_ROOT_CLAIMED", `${root} handler`);
  }
});

test("PRODUCTION_ROUTE_PORT_RETIRED: no round-12 retired route can be ported", () => {
  assert.equal(RETIRED_ROUTE_IDS.length + RETIRED_DEFINITE_ROUTE_IDS.length, 13);
  for (const id of [...RETIRED_ROUTE_IDS, ...RETIRED_DEFINITE_ROUTE_IDS]) {
    refused(() => build({ portedRouteIds: [...POSTGRES_SCOPE_ROUTE_IDS, id] }),
      "PRODUCTION_ROUTE_PORT_RETIRED", id);
  }
  // A handler offered for a 503-retired route is refused too, even without
  // porting it; a retired-definite route takes only its preamble (round 19),
  // which never makes it ported.
  for (const id of RETIRED_ROUTE_IDS) {
    const handlers = handlersFor(POSTGRES_SCOPE_ROUTE_IDS);
    handlers.set(id, stub(id));
    refused(() => build({ handlers }), "PRODUCTION_ROUTE_HANDLER_UNEXPECTED", `${id} handler`);
  }
  for (const id of RETIRED_DEFINITE_ROUTE_IDS) {
    const registry = build();
    assert.equal(registry.resolve(id).disposition, ORIGIN_ROUTE_DISPOSITIONS.DEFINITE, id);
    assert.equal(registry.portedRouteIds.includes(id), false, id);
    assert.equal(registry.portedPathnames.includes(policy.find((route) => route.id === id).pathname), false, id);
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

test("PRODUCTION_ROUTE_SCOPE_INCOMPLETE: every one of the 21 scope routes is required", () => {
  for (const id of POSTGRES_SCOPE_ROUTE_IDS) {
    const ported = [...POSTGRES_SCOPE_ROUTE_IDS.filter((scope) => scope !== id), ...OD_CR_1_CONTESTED_ROUTE_IDS];
    refused(() => build({ portedRouteIds: ported }), "PRODUCTION_ROUTE_SCOPE_INCOMPLETE", id);
  }
  refused(() => build({ portedRouteIds: [] }), "PRODUCTION_ROUTE_SCOPE_INCOMPLETE", "empty");
});

test("PRODUCTION_ROUTE_HANDLERS_INVALID: handlers must be a Map", () => {
  for (const handlers of [null, {}, Object.fromEntries(handlersFor(POSTGRES_SCOPE_ROUTE_IDS)),
    [...handlersFor(POSTGRES_SCOPE_ROUTE_IDS)]]) {
    refused(() => createProductionRouteRegistry({
      routePolicy: policy, portedRouteIds: POSTGRES_SCOPE_ROUTE_IDS, handlers,
    }), "PRODUCTION_ROUTE_HANDLERS_INVALID", String(handlers));
  }
  refused(() => createProductionRouteRegistry({ routePolicy: policy, portedRouteIds: POSTGRES_SCOPE_ROUTE_IDS }),
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
    const handlers = handlersFor(POSTGRES_SCOPE_ROUTE_IDS);
    handlers.set(key, stub(key));
    refused(() => build({ handlers }), "PRODUCTION_ROUTE_HANDLER_UNEXPECTED", key);
  }
});

test("PRODUCTION_ROUTE_HANDLER_MISSING: every ported id has a function, every retired-definite id its preamble", () => {
  const ported = [...POSTGRES_SCOPE_ROUTE_IDS, ...OD_CR_1_CONTESTED_ROUTE_IDS];
  for (const id of [...ported, ...RETIRED_DEFINITE_ROUTE_IDS]) {
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
