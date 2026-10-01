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
  assertContributionEnvelopeFormats,
  contributionEnvelopeSchemaVersion,
  contributionTransportSchemaVersion,
  createContributionEnvelopeRegistry,
  createUploadAuthorizationFormats,
  registerContributionEnvelope,
} from "./contribution-envelope-registry.mjs";
import {
  FASTPATH_TEST_SCHEMA_PREFIXES,
  fastpathTestDatabaseConfig,
  fastpathTestRouteModules,
  isAnalyticsV2Enabled,
  isFastpathTestSchema,
} from "./origin-fastpath-mode.mjs";

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
let CONTRACT_OVERRIDABLE_BUILT_INS;
try {
  ({ WORKER_ROUTE_POLICY } = await vite.ssrLoadModule("/src/route-registry.ts"));
  ({ ORIGIN_OVERRIDABLE_BUILT_INS: CONTRACT_OVERRIDABLE_BUILT_INS } =
    await vite.ssrLoadModule("/src/analytics-v2/contract.ts"));
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

test("the analytics-v2 contract names the same overridable built-ins as the runtime seam", () => {
  assert.deepEqual([...CONTRACT_OVERRIDABLE_BUILT_INS], [...ORIGIN_OVERRIDABLE_BUILT_INS]);
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

test("envelope registrations carry an optional pure pre-claim validator and receipt ownership", () => {
  const validateEnvelope = () => {};
  const registration = registerContributionEnvelope("telemetry-envelope-v1.1", stubHandler, {
    validateEnvelope,
  });
  const bare = registerContributionEnvelope("telemetry-envelope-v1.0", stubHandler);
  const owned = registerContributionEnvelope("telemetry-envelope-v1.2", stubHandler, { ownsReceipt: true });
  const registry = createContributionEnvelopeRegistry([registration, bare, owned]);
  assert.equal(registry.resolveRegistration("telemetry-envelope-v1.1"), registration);
  assert.equal(registry.resolveRegistration("telemetry-envelope-v1.1").validateEnvelope, validateEnvelope);
  assert.equal(registry.resolveRegistration("telemetry-envelope-v1.0").validateEnvelope, null);
  // The preamble records the receipt unless a registration owns it.
  assert.equal(registration.ownsReceipt, false);
  assert.equal(bare.ownsReceipt, false);
  assert.equal(owned.ownsReceipt, true);
  assert.equal(registerContributionEnvelope("telemetry-envelope-v1.1", stubHandler, {
    ownsReceipt: false,
  }).ownsReceipt, false);
  assert.equal(registry.resolve("telemetry-envelope-v1.1"), stubHandler);
  for (const unregistered of ["telemetry-envelope-v1.3", "__proto__", undefined, null, 1]) {
    assert.equal(registry.resolveRegistration(unregistered), null);
  }
  assert.ok(Object.isFrozen(registration));
  for (const options of [
    null, [], { validateEnvelope: "validate" }, { validateEnvelope, transport: "v1.1" },
    { ownsReceipt: "true" }, { ownsReceipt: null }, { ownsReceipt: 1 },
  ]) {
    assert.throws(
      () => registerContributionEnvelope("telemetry-envelope-v1.1", stubHandler, options),
      (error) => error?.code === "CONTRIBUTION_ENVELOPE_REGISTRY_INVALID",
    );
  }
  assert.throws(
    () => registerContributionEnvelope("telemetry-envelope-v1", stubHandler),
    (error) => error?.code === "CONTRIBUTION_ENVELOPE_REGISTRY_INVALID",
  );
  assert.throws(
    () => createUploadAuthorizationFormats(null),
    (error) => error?.code === "UPLOAD_AUTHORIZATION_FORMAT_INVALID",
  );
  assert.throws(
    () => registryOf([moduleFor("/api/v1/session")]),
    (error) => error?.code === "ORIGIN_ROUTE_MODULE_INVALID",
  );
});

test("envelope and transport versions map one to one", () => {
  for (const [envelope, transport] of [
    ["telemetry-envelope-v0.1", "telemetry-contribution-v0.1"],
    ["telemetry-envelope-v1.0", "telemetry-contribution-v1.0"],
    ["telemetry-envelope-v1.1", "telemetry-contribution-v1.1"],
    ["telemetry-envelope-v1.2", "telemetry-contribution-v1.2"],
  ]) {
    assert.equal(contributionTransportSchemaVersion(envelope), transport);
    assert.equal(contributionEnvelopeSchemaVersion(transport), envelope);
  }
  for (const value of [
    "telemetry-contribution-v1.2", "telemetry-envelope-v1", "telemetry-envelope-v01.2", "", null, 1.2,
  ]) {
    assert.equal(contributionTransportSchemaVersion(value), null);
  }
  for (const value of ["telemetry-envelope-v1.2", "telemetry-contribution-v1", null]) {
    assert.equal(contributionEnvelopeSchemaVersion(value), null);
  }
});

test("envelope handlers and upload-authorization formats must pair exactly", () => {
  const assertUploadAllowed = () => {};
  const envelopes = (...versions) => createContributionEnvelopeRegistry(
    versions.map((version) => registerContributionEnvelope(version, stubHandler)),
  );
  const formats = (...versions) => createUploadAuthorizationFormats(
    Object.fromEntries(versions.map((version) => [version, { assertUploadAllowed }])),
  );
  assertContributionEnvelopeFormats(envelopes(), formats());
  assertContributionEnvelopeFormats(
    envelopes("telemetry-envelope-v1.2", "telemetry-envelope-v1.1"),
    formats("telemetry-contribution-v1.1", "telemetry-contribution-v1.2"),
  );
  assert.throws(
    () => assertContributionEnvelopeFormats(envelopes("telemetry-envelope-v1.1"), formats()),
    /telemetry-envelope-v1\.1 has no telemetry-contribution-v1\.1 upload-authorization format/u,
  );
  assert.throws(
    () => assertContributionEnvelopeFormats(envelopes(), formats("telemetry-contribution-v0.2")),
    /telemetry-contribution-v0\.2 has no telemetry-envelope-v0\.2 handler/u,
  );
  assert.throws(
    () => assertContributionEnvelopeFormats({}, formats()),
    (error) => error?.code === "CONTRIBUTION_ENVELOPE_REGISTRY_INVALID",
  );
});

test("fastpath-test accepts only rehearsal schemas and their _ledger pair", () => {
  assert.deepEqual(FASTPATH_TEST_SCHEMA_PREFIXES, [
    "typed_legacy_transfer_rehearsal_target_", "tibotattle_fastpath_",
  ]);
  for (const schema of [
    "tibotattle_fastpath_a", "typed_legacy_transfer_rehearsal_target_fastpath_01",
    "tibotattle_fastpath_" + "x".repeat(36),
  ]) {
    assert.equal(isFastpathTestSchema(schema), true, schema);
  }
  for (const schema of [
    "tibotattle", "tibotattle_fastpath_", "typed_legacy_transfer_rehearsal_target_",
    "tibotattle_v12_a2_20260925", "Tibotattle_fastpath_a", "tibotattle_fastpath_a-b",
    "tibotattle_fastpath_" + "x".repeat(37), "pg_tibotattle_fastpath_a", undefined, null,
  ]) {
    assert.equal(isFastpathTestSchema(schema), false, String(schema));
  }
  const env = {
    PRIMARY_SCHEMA: "tibotattle_fastpath_a",
    PRIMARY_DATABASE: "tibotattle",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic:us-east1:primary",
  };
  assert.deepEqual(fastpathTestDatabaseConfig(env), {
    primary: {
      role: "primary", schema: "tibotattle_fastpath_a", database: "tibotattle",
      instanceConnectionName: "synthetic:us-east1:primary", max: 3,
    },
    ledger: {
      role: "ledger", schema: "tibotattle_fastpath_a_ledger", database: "tibotattle",
      instanceConnectionName: "synthetic:us-east1:primary", max: 2,
    },
  });
  assert.deepEqual(fastpathTestDatabaseConfig({
    ...env,
    LEDGER_SCHEMA: "tibotattle_fastpath_a_ledger",
    LEDGER_DATABASE: "tibotattle_ledger",
    LEDGER_INSTANCE_CONNECTION_NAME: "synthetic:us-east1:ledger",
  }).ledger, {
    role: "ledger", schema: "tibotattle_fastpath_a_ledger", database: "tibotattle_ledger",
    instanceConnectionName: "synthetic:us-east1:ledger", max: 2,
  });
  for (const [overrides, code] of [
    [{ PRIMARY_SCHEMA: "tibotattle" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ LEDGER_SCHEMA: "tibotattle_ledger" }, "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID"],
    [{ PRIMARY_DATABASE: undefined }, "PRIMARY_DATABASE_MISSING"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "" }, "PRIMARY_INSTANCE_CONNECTION_NAME_MISSING"],
  ]) {
    assert.throws(() => fastpathTestDatabaseConfig({ ...env, ...overrides }), (error) => error?.code === code);
  }
});

test("fastpath-test mounts the analytics-v2 community-daily module only when enabled", () => {
  assert.equal(isAnalyticsV2Enabled({}), false);
  assert.equal(isAnalyticsV2Enabled({ ANALYTICS_V2_ENABLED: "" }), false);
  assert.equal(isAnalyticsV2Enabled({ ANALYTICS_V2_ENABLED: "0" }), false);
  assert.equal(isAnalyticsV2Enabled({ ANALYTICS_V2_ENABLED: "1" }), true);
  for (const value of ["true", "yes", "01", " 1"]) {
    assert.throws(() => isAnalyticsV2Enabled({ ANALYTICS_V2_ENABLED: value }),
      (error) => error?.code === "ANALYTICS_V2_ENABLED_INVALID");
  }
  const pool = { connect() {} };
  const calls = [];
  const factory = (options) => {
    calls.push(options);
    return { method: "GET", pathname: "/api/v1/community/daily", overridesBuiltIn: true, handler: stubHandler };
  };
  assert.deepEqual(fastpathTestRouteModules({
    env: {}, primaryPool: pool, primarySchema: "tibotattle_fastpath_a", createAnalyticsV2CommunityDailyRoute: factory,
  }), []);
  assert.equal(calls.length, 0);
  const clock = () => 0;
  const [mounted] = fastpathTestRouteModules({
    env: { ANALYTICS_V2_ENABLED: "1" },
    primaryPool: pool,
    primarySchema: "tibotattle_fastpath_a",
    createAnalyticsV2CommunityDailyRoute: factory,
    clock,
  });
  assert.deepEqual(calls, [{ pool, schema: "tibotattle_fastpath_a", originMode: "fastpath-test", clock }]);
  assert.equal(registryOf([mounted]).resolve("GET", "/api/v1/community/daily"), mounted);
  assert.deepEqual(Object.keys(fastpathTestRouteModules({
    env: { ANALYTICS_V2_ENABLED: "1" }, primaryPool: pool, primarySchema: "tibotattle_fastpath_a",
    createAnalyticsV2CommunityDailyRoute: factory,
  })[0]).sort(), ["handler", "method", "overridesBuiltIn", "pathname"]);
  assert.equal(Object.hasOwn(calls.at(-1), "clock"), false);
  for (const [options, code] of [
    [{ createAnalyticsV2CommunityDailyRoute: null }, "ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_UNAVAILABLE"],
    [{ createAnalyticsV2CommunityDailyRoute: factory, clock: 0 }, "ANALYTICS_V2_CLOCK_INVALID"],
    [{ createAnalyticsV2CommunityDailyRoute: () => null }, "ANALYTICS_V2_COMMUNITY_DAILY_ROUTE_INVALID"],
    [{ createAnalyticsV2CommunityDailyRoute: () => ({ method: "GET" }) }, "ORIGIN_ROUTE_MODULE_INVALID"],
  ]) {
    assert.throws(() => fastpathTestRouteModules({
      env: { ANALYTICS_V2_ENABLED: "1" }, primaryPool: pool, primarySchema: "tibotattle_fastpath_a", ...options,
    }), (error) => error?.code === code);
  }
});
