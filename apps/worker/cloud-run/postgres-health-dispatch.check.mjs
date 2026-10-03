import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// RD-3 dispatcher (D-CRB) without a database: the capability flags derive
// from the route registry (OD-CR-5), the Worker order runs the enrollment
// mode and the preflight before any read, a wrong method is the Worker's
// 405, and construction is closed. The readers and the full body run against
// PostgreSQL 17 in postgres-test/postgres-production-host.spec.mjs. Every
// value is synthetic.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let vite;
let health;
let registryModule;
let routeRegistry;
let composition;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  [health, registryModule, routeRegistry, composition] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-health-dispatch.mjs"),
    vite.ssrLoadModule("/cloud-run/postgres-production-registry.mjs"),
    vite.ssrLoadModule("/src/route-registry.ts"),
    vite.ssrLoadModule("/src/backend-composition.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function registryFor(ported) {
  return registryModule.createProductionRouteRegistry({
    routePolicy: routeRegistry.WORKER_ROUTE_POLICY,
    handlers: new Map(ported.map((id) => [id, async () => new Response(null)])),
    portedRouteIds: ported,
  });
}

test("OD-CR-5: the capability flags derive from the registry, false while their routes are unported", () => {
  assert.deepEqual(Object.keys(health.HEALTH_CAPABILITY_ROUTE_IDS), ["participantExport", "coordinatedSignInAdmission"]);
  const production = registryFor([...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS]);
  const flags = health.healthCapabilityFlags(health.registryPorted(production));
  assert.ok(Object.isFrozen(flags));
  assert.deepEqual({ ...flags }, { participantExport: false, coordinatedSignInAdmission: false });
  // The open admin host ports none of the routes the flags name.
  const admin = registryFor([...composition.POSTGRES_PORTED_WORKER_ROUTE_IDS,
    ...composition.POSTGRES_ADMIN_HOST_ROUTE_IDS]);
  assert.deepEqual({ ...health.healthCapabilityFlags(health.registryPorted(admin)) },
    { participantExport: false, coordinatedSignInAdmission: false });
  // A flag turns true only when every route it names is ported.
  assert.deepEqual({ ...health.healthCapabilityFlags((id) => id === "participant_export") },
    { participantExport: true, coordinatedSignInAdmission: false });
  assert.deepEqual({ ...health.healthCapabilityFlags((id) => id === "identity_google_start") },
    { participantExport: false, coordinatedSignInAdmission: true });
  assert.deepEqual({ ...health.healthCapabilityFlags(() => "yes") },
    { participantExport: false, coordinatedSignInAdmission: false }, "only a boolean true counts");
  assert.throws(() => health.healthCapabilityFlags(null), { code: health.HEALTH_DISPATCH_CONFIGURATION_INVALID });
  assert.equal(health.HEALTH_PROBE_OBJECT_KEY, "__usage_monitor_health_probe__");
});

function dispatchFor(env, calls) {
  return health.createPostgresHealthDispatch({
    requestContext: () => undefined,
    env,
    readinessPool: {
      async connect() {
        calls.push("connect");
        throw new Error("the preflight must refuse before any database read");
      },
    },
    primarySchema: "synthetic_health",
    objectStore: { async head() { calls.push("head"); return null; }, async put() {}, async delete() {} },
    capabilityFlags: Object.freeze({ participantExport: false, coordinatedSignInAdmission: false }),
  });
}

test("Worker order: the enrollment mode, then the preflight, before any read or object probe", async () => {
  const calls = [];
  const invalidMode = dispatchFor(Object.freeze({ ENROLLMENT_MODE: "sometimes" }), calls);
  const modeAnswer = await invalidMode(new Request("https://tibotattle.test/api/health"));
  assert.equal(modeAnswer.status, 503);
  assert.equal((await modeAnswer.json()).error.code, "ADMISSION_CONFIGURATION_INVALID");
  const noBindings = dispatchFor(Object.freeze({ ENROLLMENT_MODE: "open" }), calls);
  const bindingAnswer = await noBindings(new Request("https://tibotattle.test/api/health"));
  assert.equal(bindingAnswer.status, 503);
  assert.equal((await bindingAnswer.json()).error.code, "ADMISSION_CONFIGURATION_INVALID");
  assert.equal(bindingAnswer.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [], "no connection and no object probe before the preflight passes");
  const post = await noBindings(new Request("https://tibotattle.test/api/health", { method: "POST" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("construction refuses an incomplete dependency set or unfrozen flags", () => {
  const base = {
    requestContext: () => undefined,
    env: Object.freeze({}),
    readinessPool: { async connect() {} },
    primarySchema: "synthetic_health",
    objectStore: {},
    capabilityFlags: Object.freeze({ participantExport: false, coordinatedSignInAdmission: false }),
  };
  assert.equal(typeof health.createPostgresHealthDispatch(base), "function");
  for (const override of [
    { requestContext: null },
    { env: {} },
    { readinessPool: null },
    { primarySchema: undefined },
    { objectStore: null },
    { capabilityFlags: { participantExport: false, coordinatedSignInAdmission: false } },
    { clock: 1 },
  ]) {
    assert.throws(() => health.createPostgresHealthDispatch({ ...base, ...override }),
      { code: health.HEALTH_DISPATCH_CONFIGURATION_INVALID }, Object.keys(override).join());
  }
});
