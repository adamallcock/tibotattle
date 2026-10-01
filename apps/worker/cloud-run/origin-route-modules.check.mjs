import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import {
  createOriginRouteModuleRegistry,
  defineOriginRouteModule,
  ORIGIN_OVERRIDABLE_BUILT_INS,
} from "./origin-route-modules.mjs";
import {
  createContributionEnvelopeRegistry,
  createUploadAuthorizationFormats,
  registerContributionEnvelope,
} from "./contribution-envelope-registry.mjs";

// Loads the Worker route registry the way edge-origin-contract.check.mjs
// loads Worker source, then checks the origin seams against it. Every handler
// here is a synthetic stub; nothing touches a database or the network.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, ws: false },
  appType: "custom",
});
let WORKER_ROUTE_POLICY;
try {
  ({ WORKER_ROUTE_POLICY } = await vite.ssrLoadModule("/src/route-registry.ts"));
} finally {
  await vite.close();
}

const stubHandler = () => new Response(null, { status: 204 });

function moduleFor(pathname, overrides = {}) {
  return defineOriginRouteModule({
    method: "GET",
    pathname,
    overridesBuiltIn: true,
    handler: stubHandler,
    ...overrides,
  });
}

function registryOf(modules) {
  return createOriginRouteModuleRegistry({ modules, routePolicy: WORKER_ROUTE_POLICY });
}

test("every overridable built-in is an exact WORKER_ROUTE_POLICY route", () => {
  assert.ok(Array.isArray(WORKER_ROUTE_POLICY) && WORKER_ROUTE_POLICY.length > 0);
  const registryPaths = new Set(WORKER_ROUTE_POLICY.map((route) => route.pathname));
  assert.ok(ORIGIN_OVERRIDABLE_BUILT_INS.length > 0);
  assert.equal(new Set(ORIGIN_OVERRIDABLE_BUILT_INS).size, ORIGIN_OVERRIDABLE_BUILT_INS.length);
  for (const pathname of ORIGIN_OVERRIDABLE_BUILT_INS) {
    assert.ok(registryPaths.has(pathname), pathname + " is missing from WORKER_ROUTE_POLICY");
  }
  assert.ok(Object.isFrozen(ORIGIN_OVERRIDABLE_BUILT_INS));
});

test("an empty module registry resolves nothing", () => {
  const registry = registryOf([]);
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.pathnames, []);
  for (const pathname of ORIGIN_OVERRIDABLE_BUILT_INS) {
    assert.equal(registry.resolve("GET", pathname), null);
    assert.equal(registry.resolve("POST", pathname), null);
  }
});

test("a module for each overridable built-in resolves only on its registry method", () => {
  const daily = moduleFor("/api/v1/community/daily");
  const authorizations = moduleFor("/api/v1/device/upload-authorizations", { method: "POST" });
  const registry = registryOf([daily, authorizations]);
  assert.equal(registry.size, 2);
  assert.equal(registry.resolve("GET", "/api/v1/community/daily"), daily);
  assert.equal(registry.resolve("POST", "/api/v1/community/daily"), null);
  assert.equal(registry.resolve("POST", "/api/v1/device/upload-authorizations"), authorizations);
  assert.equal(registry.resolve("GET", "/api/v1/device/upload-authorizations"), null);
  assert.equal(registry.resolve("GET", "/api/v1/community/daily/"), null);
  assert.equal(registry.resolve(undefined, "/api/v1/community/daily"), null);
  assert.ok(Object.isFrozen(registry) && Object.isFrozen(daily));
});

test("a module claiming a non-overridable built-in throws at startup", () => {
  for (const overridesBuiltIn of [true, false]) {
    assert.throws(
      () => registryOf([moduleFor("/api/v1/session", { overridesBuiltIn })]),
      /ORIGIN_ROUTE_MODULE_INVALID: \/api\/v1\/session is a built-in route/u,
    );
  }
  assert.throws(
    () => registryOf([moduleFor("/api/v1/contributions", { method: "POST" })]),
    /built-in route that modules may not replace/u,
  );
});

test("a non-registry pathname, undeclared override, wrong method or duplicate throws", () => {
  assert.throws(
    () => registryOf([moduleFor("/api/v1/community/daily-v2")]),
    /not a route in the Worker route registry/u,
  );
  assert.throws(
    () => registryOf([moduleFor("/api/v1/community/daily", { overridesBuiltIn: false })]),
    /must declare overridesBuiltIn: true/u,
  );
  assert.throws(
    () => registryOf([moduleFor("/api/v1/community/daily", { method: "POST" })]),
    /POST is not a registry method/u,
  );
  assert.throws(
    () => registryOf([moduleFor("/api/v1/community/daily"), moduleFor("/api/v1/community/daily")]),
    /more than one module claims GET \/api\/v1\/community\/daily/u,
  );
  assert.throws(
    () => registryOf([Object.freeze({
      method: "GET",
      pathname: "/api/v1/community/daily",
      overridesBuiltIn: true,
      handler: stubHandler,
    })]),
    /only modules returned by defineOriginRouteModule/u,
  );
});

test("defineOriginRouteModule rejects malformed definitions", () => {
  const valid = {
    method: "GET", pathname: "/api/v1/community/daily", overridesBuiltIn: true, handler: stubHandler,
  };
  for (const definition of [
    null,
    [],
    { ...valid, method: "PUT" },
    { ...valid, pathname: "/community/daily" },
    { ...valid, overridesBuiltIn: "true" },
    { ...valid, handler: "handler" },
    { ...valid, extra: true },
    { method: "GET", pathname: "/api/v1/community/daily", handler: stubHandler },
  ]) {
    assert.throws(() => defineOriginRouteModule(definition), /ORIGIN_ROUTE_MODULE_INVALID/u);
  }
});

test("the registry refuses a route policy that lacks an overridable built-in", () => {
  const policy = WORKER_ROUTE_POLICY.filter((route) => route.pathname !== "/api/v1/community/daily");
  assert.throws(
    () => createOriginRouteModuleRegistry({ modules: [], routePolicy: policy }),
    /overridable built-in \/api\/v1\/community\/daily is not in the route policy/u,
  );
  assert.throws(
    () => createOriginRouteModuleRegistry({ modules: [], routePolicy: [] }),
    /routePolicy must be the non-empty WORKER_ROUTE_POLICY array/u,
  );
  assert.throws(() => createOriginRouteModuleRegistry(), /routePolicy/u);
});

test("the envelope registry resolves registered versions only", () => {
  const empty = createContributionEnvelopeRegistry([]);
  assert.deepEqual(empty.schemaVersions, []);
  assert.equal(empty.resolve("telemetry-envelope-v1.2"), null);

  const v12 = () => new Response(null, { status: 201 });
  const registry = createContributionEnvelopeRegistry([
    registerContributionEnvelope("telemetry-envelope-v1.2", v12),
  ]);
  assert.deepEqual(registry.schemaVersions, ["telemetry-envelope-v1.2"]);
  assert.equal(registry.resolve("telemetry-envelope-v1.2"), v12);
  assert.equal(registry.has("telemetry-envelope-v1.2"), true);
  for (const unregistered of [
    "telemetry-envelope-v1.1", "constructor", "__proto__", "toString", undefined, null, 1.2, {},
  ]) {
    assert.equal(registry.resolve(unregistered), null);
    assert.equal(registry.has(unregistered), false);
  }
  assert.ok(Object.isFrozen(registry) && Object.isFrozen(registry.schemaVersions));
});

test("the envelope registry refuses malformed or duplicate registrations", () => {
  for (const schemaVersion of [
    "telemetry-contribution-v1.2", "telemetry-envelope-v1", "telemetry-envelope-v01.2", "", 12,
  ]) {
    assert.throws(
      () => registerContributionEnvelope(schemaVersion, stubHandler),
      /CONTRIBUTION_ENVELOPE_REGISTRY_INVALID/u,
    );
  }
  assert.throws(
    () => registerContributionEnvelope("telemetry-envelope-v1.1", null),
    /handler must be a function/u,
  );
  assert.throws(
    () => createContributionEnvelopeRegistry([
      registerContributionEnvelope("telemetry-envelope-v1.1", stubHandler),
      registerContributionEnvelope("telemetry-envelope-v1.1", stubHandler),
    ]),
    /more than one handler claims telemetry-envelope-v1.1/u,
  );
  assert.throws(
    () => createContributionEnvelopeRegistry([
      Object.freeze({ schemaVersion: "telemetry-envelope-v1.1", handler: stubHandler }),
    ]),
    /only values returned by registerContributionEnvelope/u,
  );
  assert.throws(() => createContributionEnvelopeRegistry(), /registrations must be an array/u);
});

test("upload-authorization formats accept registered telemetry schema versions only", () => {
  const empty = createUploadAuthorizationFormats({});
  assert.deepEqual(empty.telemetrySchemaVersions, []);
  assert.equal(empty.resolve("telemetry-contribution-v1.2"), null);

  const assertUploadAllowed = async () => {};
  for (const formats of [
    createUploadAuthorizationFormats({ "telemetry-contribution-v1.2": { assertUploadAllowed } }),
    createUploadAuthorizationFormats(new Map([
      ["telemetry-contribution-v1.2", { assertUploadAllowed }],
    ])),
  ]) {
    assert.deepEqual(formats.telemetrySchemaVersions, ["telemetry-contribution-v1.2"]);
    assert.equal(formats.resolve("telemetry-contribution-v1.2").assertUploadAllowed, assertUploadAllowed);
    assert.ok(Object.isFrozen(formats.resolve("telemetry-contribution-v1.2")));
    for (const unregistered of [
      "telemetry-contribution-v1.1", "constructor", "__proto__", "hasOwnProperty", undefined, null,
    ]) {
      assert.equal(formats.resolve(unregistered), null);
      assert.equal(formats.has(unregistered), false);
    }
    assert.ok(Object.isFrozen(formats));
  }
});

test("upload-authorization formats refuse malformed tables", () => {
  const assertUploadAllowed = () => {};
  for (const map of [
    null,
    [],
    "telemetry-contribution-v1.2",
    { "telemetry-envelope-v1.2": { assertUploadAllowed } },
    { "telemetry-contribution-v1.2": null },
    { "telemetry-contribution-v1.2": {} },
    { "telemetry-contribution-v1.2": { assertUploadAllowed: true } },
    { "telemetry-contribution-v1.2": { assertUploadAllowed, transport: "v1.2" } },
    new Map([[12, { assertUploadAllowed }]]),
  ]) {
    assert.throws(
      () => createUploadAuthorizationFormats(map),
      /UPLOAD_AUTHORIZATION_FORMAT_INVALID/u,
    );
  }
});
