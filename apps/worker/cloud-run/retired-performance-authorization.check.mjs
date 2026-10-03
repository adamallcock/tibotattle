import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Owner round 19 (2026-10-03): the retired accountless performance
// authorization answers production's exact sequence (d43c8f92
// handleAccountlessTelemetryPerformanceAuthorization), then the terminal
// 403 TELEMETRY_TRANSPORT_BLOCKED. Without a database: the real preamble
// (postgres-test-dispatch.mjs), the real CR-6 registry and request handler,
// the real EP-6 boundary and admission replay, and the Worker's own
// admission and bounded-body helpers, over a synthetic pool that answers the
// collection-control read and a synthetic device authenticator. One test per
// step of the sequence; postgres-test/postgres-production-host.spec.mjs runs
// the same sequence over PostgreSQL 17 with a really enrolled device. Every
// token, key and bearer is synthetic; nothing listens.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ORIGIN = "https://tibotattle.test";
const EDGE_REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const INVOKER = "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const VERIFIER = "origin-verifier@synthetic-edge-0.iam.gserviceaccount.com";
const AUDIENCE = "https://origin.synthetic.example";
const ROUTE_ID = "accountless_telemetry_performance_authorization";
const PATH = "/api/v1/accountless/telemetry-performance-authorization";
const GOOD_BEARER = "Device um_device_synthetic-accountless.good";
const SOCIAL_BEARER = "Device um_device_synthetic-social.good";
const SESSION_COOKIE = "__Host-usage_monitor_session=synthetic-session";

let vite;
let testDispatch;
let hostDispatch;
let registryModule;
let contextModule;
let edgeDispatch;
let limiters;
let admission;
let boundedBody;
let errors;
let routeRegistry;
let performancePolicy;
let constants;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  const load = (path) => vite.ssrLoadModule(path);
  [testDispatch, hostDispatch, registryModule, contextModule, edgeDispatch, limiters, admission, boundedBody, errors,
    routeRegistry, performancePolicy, constants] = await Promise.all([
    load("/cloud-run/postgres-test-dispatch.mjs"),
    load("/cloud-run/postgres-host-dispatch.mjs"),
    load("/cloud-run/postgres-production-registry.mjs"),
    load("/cloud-run/postgres-request-context.mjs"),
    load("/cloud-run/postgres-edge-origin-dispatch.mjs"),
    load("/cloud-run/postgres-edge-admission-limiters.mjs"),
    load("/src/admission.ts"),
    load("/src/bounded-body.ts"),
    load("/src/errors.ts"),
    load("/src/route-registry.ts"),
    load("/src/telemetry-performance-policy.ts"),
    load("/src/constants.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

// ---------------------------------------------------------------------------
// Fixture

function requestShape() {
  return Object.freeze({
    schemaVersion: performancePolicy.ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION,
    policyVersion: performancePolicy.ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION,
    authorizationBasis: performancePolicy.ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS,
  });
}

function validBody() {
  return JSON.stringify(requestShape());
}

/**
 * A pool that answers the collection-control read (the only query the
 * preamble makes itself) and records every statement. controls is mutable.
 */
function controlsPool(state) {
  const statements = [];
  return {
    statements,
    async connect() {
      return {
        async query(sql) {
          statements.push(sql.replace(/\s+/gu, " ").trim());
          if (!/collection_controls/u.test(sql)) return { rows: [], rowCount: 0 };
          const flags = state.controls;
          const enabled = [flags.enrollment, flags.uploadRegistration, flags.processing, flags.publication];
          const count = enabled.filter(Boolean).length;
          return {
            rowCount: 1,
            rows: [{
              revision: 2,
              control_state: count === 4 ? "operational" : count === 0 ? "contained" : "degraded",
              enrollment_enabled: flags.enrollment,
              upload_registration_enabled: flags.uploadRegistration,
              processing_enabled: flags.processing,
              publication_enabled: flags.publication,
            }],
          };
        },
        release() {},
      };
    },
  };
}

function admissionEnvOf(replay, overrides = {}) {
  return Object.freeze({
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    IDENTITY_LINK_SECRET: "synthetic-identity-link-secret-value-0000000001",
    ENROLLMENT_RATE_LIMIT: replay.bindings.ENROLLMENT_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: replay.bindings.RECOVERY_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: replay.bindings.CLIENT_ATTEMPT_RATE_LIMIT,
    PUBLIC_READ_RATE_LIMIT: replay.bindings.PUBLIC_READ_RATE_LIMIT,
    ...overrides,
  });
}

/**
 * The production pipeline for this one route: EP-6 in front of the CR-6
 * handler over a registry whose retired-definite preamble is the real one.
 */
function fixture({ envOverrides = {}, readBoundedRequestBody } = {}) {
  const state = {
    storageCurrent: true,
    controls: { enrollment: true, uploadRegistration: true, processing: true, publication: true },
  };
  const pool = controlsPool(state);
  const authentications = [];
  const gateCalls = [];
  const replay = limiters.createEdgeAdmissionLimiters();
  const store = contextModule.createRequestContextStore();
  const preamble = testDispatch.createPostgresRetiredPerformanceAuthorizationPreamble({
    requestContext: store.accessor,
    primaryPool: pool,
    schemaOptions: Object.freeze({ primarySchema: "synthetic_primary" }),
    storageGate: {
      async assertCurrent() {
        gateCalls.push(true);
        if (!state.storageCurrent) throw new Error("receipt drift");
      },
    },
    admissionEnv: admissionEnvOf(replay, envOverrides),
    assertAdmissionBindings: admission.assertAdmissionBindings,
    assertAttemptAllowed: admission.assertAttemptAllowed,
    // The Worker's generic gate, then accountless only (the real port is
    // authenticatePostgresAccountlessForV12Grant, proved over PostgreSQL in
    // postgres-device-bearer-auth.spec.mjs).
    async authenticateAccountlessDevice(primaryPool, header, options) {
      authentications.push({ pool: primaryPool, header, options });
      if (header === GOOD_BEARER) return Object.freeze({ deviceId: "d", participantId: "p", authorityKind: "accountless" });
      throw new errors.ApiError(401, "DEVICE_AUTH_INVALID");
    },
    readBoundedRequestBody: readBoundedRequestBody ?? boundedBody.readBoundedRequestBody,
    maxRequestBytes: constants.MAX_REQUEST_BYTES,
    requestShape: requestShape(),
  });
  const scope = registryModule.POSTGRES_SCOPE_ROUTE_IDS;
  const familyCalls = [];
  const handlers = new Map(scope.map((id) => [id, async () => {
    familyCalls.push(id);
    return Response.json({ served: id });
  }]));
  handlers.set(ROUTE_ID, preamble);
  const registry = registryModule.createProductionRouteRegistry({
    routePolicy: routeRegistry.WORKER_ROUTE_POLICY, handlers, portedRouteIds: scope,
  });
  const lines = [];
  const handler = hostDispatch.createProductionRequestHandler({
    registry,
    env: Object.freeze({ PUBLIC_ORIGIN, PUBLIC_ANALYTICS_MODE: "enabled" }),
    requestContextStore: store,
    requestContext: edgeDispatch.edgeRequestContext,
    storageGate: { async assertCurrent() {} },
    recordDiagnostic: async () => {},
    logger: (line) => { lines.push(line); },
    adminHostPolicy: "refuse",
    unportedRetryAfterSeconds: null,
  });
  const boundary = edgeDispatch.createEdgeOriginDispatch({
    invokerServiceAccount: INVOKER,
    verifierServiceAccounts: [VERIFIER],
    audience: AUDIENCE,
    publicOrigin: PUBLIC_ORIGIN,
    admission: replay,
    inner: handler,
  });
  return { state, pool, authentications, gateCalls, familyCalls, lines, boundary, preamble, store };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function invokerToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: AUDIENCE, email: INVOKER, email_verified: true, exp: now + 3_000, iat: now - 60,
    iss: "https://accounts.google.com", sub: "100000000000000000000",
  };
  return `Bearer ${base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" })}.${base64UrlJson(payload)}`
    + ".SIGNATURE_REMOVED_BY_GOOGLE";
}

/**
 * A forwarded request as Cloud Run delivers it. outcome is the edge's
 * accountless_ownership admission outcome; null omits it, the bearer, the
 * content type or the body.
 */
function forwarded({ method = "POST", outcome = "allowed", bearer = GOOD_BEARER, cookie, contentType = "application/json",
  body = validBody(), query = "", headers = {} } = {}) {
  return new Request(`https://origin.synthetic.example${PATH}${query}`, {
    method,
    headers: {
      "x-serverless-authorization": invokerToken(),
      "x-tibotattle-edge-host": "apex",
      "x-tibotattle-edge-request-id": EDGE_REQUEST_ID,
      ...(outcome === null ? {} : { "x-tibotattle-edge-admission": `v1;accountless_ownership;${outcome}` }),
      ...(bearer === null ? {} : { authorization: bearer }),
      ...(cookie === undefined ? {} : { cookie }),
      ...(contentType === null ? {} : { "content-type": contentType }),
      ...headers,
    },
    ...(body === null || method === "GET" ? {} : { body, duplex: "half" }),
  });
}

/** The Worker envelope under the edge's request id, no-store, marked by EP-6. */
async function assertAnswer(response, status, code, label, { retryAfter = null, allow = null } = {}) {
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", label);
  assert.equal(response.headers.get("x-tibotattle-origin"), "1", `${label}: marked`);
  assert.equal(response.headers.get("retry-after"), retryAfter, label);
  assert.equal(response.headers.get("allow"), allow, label);
  assert.deepEqual(await response.json(), { error: { code, requestId: EDGE_REQUEST_ID } }, label);
}

const TERMINAL = Object.freeze([403, "TELEMETRY_TRANSPORT_BLOCKED"]);

// ---------------------------------------------------------------------------
// The sequence, one step at a time

test("the terminal answer: every check passes, then 403 TELEMETRY_TRANSPORT_BLOCKED, never a grant", async () => {
  const f = fixture();
  await assertAnswer(await f.boundary(forwarded()), ...TERMINAL, "valid request");
  assert.deepEqual([...TERMINAL],
    Object.values(registryModule.RETIRED_ROUTE_DEFINITE_ANSWERS[ROUTE_ID]));
  // It authenticated the bearer once, under the configured schema, and read
  // only the collection controls (no write; the grant never runs).
  assert.equal(f.authentications.length, 1);
  assert.deepEqual({ ...f.authentications[0].options.schema }, { primarySchema: "synthetic_primary" });
  assert.equal(f.authentications[0].header, GOOD_BEARER);
  assert.equal(f.authentications[0].pool, f.pool);
  assert.ok(f.pool.statements.some((sql) => /FROM "synthetic_primary"\."collection_controls"/u.test(sql)));
  assert.ok(f.pool.statements.every((sql) => /^(BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL |SELECT |COMMIT$)/u.test(sql)), "read-only");
  assert.deepEqual(f.familyCalls, []);
  // Like the Worker, the query string is ignored and an unrelated cookie is no session.
  await assertAnswer(await f.boundary(forwarded({ query: "?synthetic=1" })), ...TERMINAL, "query string");
  await assertAnswer(await f.boundary(forwarded({ cookie: "theme=dark" })), ...TERMINAL, "unrelated cookie");
  // Logged as the Worker logs a 4xx.
  const line = JSON.parse(f.lines.at(-1));
  assert.deepEqual([line.event, line.level, line.routeClass, line.code, line.status],
    ["request_failed", "warn", ROUTE_ID, "TELEMETRY_TRANSPORT_BLOCKED", 403]);
});

test("step 0: a wrong method is the registry's 405 with Allow: POST, before the preamble", async () => {
  const f = fixture();
  for (const method of ["GET", "DELETE", "PUT"]) {
    await assertAnswer(await f.boundary(forwarded({ method, body: null, cookie: SESSION_COOKIE })), 405,
      "METHOD_NOT_ALLOWED", method, { allow: "POST" });
  }
  assert.equal(f.gateCalls.length + f.authentications.length + f.pool.statements.length, 0);
});

test("step 1: a session cookie is 401 AUTH_INVALID before anything is read", async () => {
  const f = fixture();
  f.state.storageCurrent = false;
  // Every later check would also refuse: the cookie answers first.
  await assertAnswer(await f.boundary(forwarded({ cookie: `a=b; ${SESSION_COOKIE}`, outcome: "limited",
    bearer: "Device unknown", contentType: "text/plain", body: "x" })), 401, "AUTH_INVALID", "session cookie");
  assert.equal(f.gateCalls.length + f.authentications.length + f.pool.statements.length, 0);
});

test("step 2: the storage gate is 503 BACKEND_STORAGE_UNAVAILABLE (OD-CR-6 (iii))", async () => {
  const f = fixture();
  f.state.storageCurrent = false;
  await assertAnswer(await f.boundary(forwarded({ outcome: "limited", bearer: "Device unknown" })), 503,
    "BACKEND_STORAGE_UNAVAILABLE", "storage");
  assert.equal(f.gateCalls.length, 1);
  assert.equal(f.authentications.length + f.pool.statements.length, 0);
});

test("step 3: ACCOUNTLESS_OWNERSHIP_MODE disabled or invalid is the Worker's 503", async () => {
  for (const [mode, code] of [[undefined, "ACCOUNTLESS_OWNERSHIP_DISABLED"], ["disabled", "ACCOUNTLESS_OWNERSHIP_DISABLED"],
    ["synthetic", "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID"]]) {
    const f = fixture({ envOverrides: { ACCOUNTLESS_OWNERSHIP_MODE: mode } });
    await assertAnswer(await f.boundary(forwarded({ outcome: "limited" })), 503, code, String(mode));
    assert.equal(f.authentications.length + f.pool.statements.length, 0, String(mode));
  }
});

test("step 4: a missing admission binding is 503 ADMISSION_CONFIGURATION_INVALID", async () => {
  for (const name of ["ENROLLMENT_RATE_LIMIT", "RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT", "PUBLIC_READ_RATE_LIMIT"]) {
    const f = fixture({ envOverrides: { [name]: undefined } });
    await assertAnswer(await f.boundary(forwarded({ outcome: "limited" })), 503, "ADMISSION_CONFIGURATION_INVALID", name);
    assert.equal(f.authentications.length + f.pool.statements.length, 0, name);
  }
});

test("step 5: upload registration paused is 503 UPLOAD_REGISTRATION_DISABLED, before the limiter", async () => {
  const f = fixture();
  f.state.controls.uploadRegistration = false;
  await assertAnswer(await f.boundary(forwarded({ outcome: "limited" })), 503, "UPLOAD_REGISTRATION_DISABLED", "paused");
  assert.equal(f.authentications.length, 0);
});

test("step 6: the replayed accountless_ownership limiter is 429, or 503 when unavailable, before the bearer", async () => {
  for (const [outcome, status, code] of [
    ["limited", 429, "ATTEMPT_LIMIT_REACHED"],
    ["unavailable", 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"],
    // No outcome from the edge: the replay cannot admit, the helper's 503.
    [null, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"],
  ]) {
    const f = fixture();
    await assertAnswer(await f.boundary(forwarded({ outcome, bearer: "Device unknown", body: "{}" })), status, code,
      String(outcome), { retryAfter: "60" });
    assert.equal(f.authentications.length, 0, String(outcome));
  }
  // A purpose the route does not charge is a replay mismatch: the helper's 503.
  const f = fixture();
  const wrongPurpose = forwarded();
  const request = new Request(wrongPurpose, {
    headers: { ...Object.fromEntries(wrongPurpose.headers), "x-tibotattle-edge-admission": "v1;enrollment;allowed" },
  });
  await assertAnswer(await f.boundary(request), 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE", "enrollment purpose",
    { retryAfter: "60" });
});

test("step 7: an unknown, malformed, missing or non-accountless bearer is 401 DEVICE_AUTH_INVALID, before the body", async () => {
  for (const bearer of ["Device unknown", SOCIAL_BEARER, null, "Bearer synthetic"]) {
    const f = fixture();
    await assertAnswer(await f.boundary(forwarded({ bearer, contentType: "text/plain", body: "x" })), 401,
      "DEVICE_AUTH_INVALID", String(bearer));
    assert.equal(f.authentications.length, 1);
    assert.equal(f.authentications[0].header, bearer);
  }
});

test("step 8: the body is readBoundedJson's, then the closed three-key shape", async () => {
  const shape = requestShape();
  const cases = [
    [{ contentType: null }, 415, "CONTENT_TYPE_INVALID"],
    [{ contentType: "text/plain" }, 415, "CONTENT_TYPE_INVALID"],
    [{ contentType: "application/json; charset=utf-8" }, ...TERMINAL],
    [{ headers: { "content-length": String(constants.MAX_REQUEST_BYTES + 1) } }, 413, "BODY_TOO_LARGE"],
    [{ body: "" }, 400, "BODY_INVALID"],
    [{ body: "{" }, 400, "BODY_INVALID"],
    [{ body: "{}" }, 400, "BODY_INVALID"],
    [{ body: "null" }, 400, "BODY_INVALID"],
    [{ body: "[]" }, 400, "BODY_INVALID"],
    [{ body: JSON.stringify({ ...shape, extra: 1 }) }, 400, "BODY_INVALID"],
    [{ body: JSON.stringify({ ...shape, schemaVersion: "accountless-performance-owner-v2" }) }, 400, "BODY_INVALID"],
    [{ body: JSON.stringify({ schemaVersion: shape.schemaVersion, policyVersion: shape.policyVersion }) }, 400,
      "BODY_INVALID"],
    [{ body: Buffer.from([0x7b, 0xff, 0x7d]) }, 400, "BODY_INVALID"],
    [{ body: "x".repeat(constants.MAX_REQUEST_BYTES + 1) }, 413, "BODY_TOO_LARGE"],
    // Key order is free, as JSON objects are.
    [{ body: JSON.stringify({ authorizationBasis: shape.authorizationBasis, policyVersion: shape.policyVersion,
      schemaVersion: shape.schemaVersion }) }, ...TERMINAL],
  ];
  for (const [init, status, code] of cases) {
    const f = fixture();
    await assertAnswer(await f.boundary(forwarded(init)), status, code, JSON.stringify(init).slice(0, 120));
    assert.equal(f.authentications.length, 1);
  }
  // A body read that times out keeps the reader's 408 BODY_TIMEOUT.
  const f = fixture({ readBoundedRequestBody: async () => { throw new errors.ApiError(408, "BODY_TIMEOUT"); } });
  await assertAnswer(await f.boundary(forwarded()), 408, "BODY_TIMEOUT", "timeout");
});

test("the observed answers are RETIRED_DEFINITE_PREAMBLE_STEPS, in order, then the terminal answer", async () => {
  const observed = [];
  const record = async (f, init) => {
    const response = await f.boundary(forwarded(init));
    const body = await response.json();
    observed.push([response.status, body.error.code]);
  };
  await record(fixture(), { cookie: SESSION_COOKIE });
  { const f = fixture(); f.state.storageCurrent = false; await record(f, {}); }
  await record(fixture({ envOverrides: { ACCOUNTLESS_OWNERSHIP_MODE: "disabled" } }), {});
  await record(fixture({ envOverrides: { ACCOUNTLESS_OWNERSHIP_MODE: "synthetic" } }), {});
  await record(fixture({ envOverrides: { PUBLIC_READ_RATE_LIMIT: undefined } }), {});
  { const f = fixture(); f.state.controls.uploadRegistration = false; await record(f, {}); }
  await record(fixture(), { outcome: "limited" });
  await record(fixture(), { outcome: "unavailable" });
  await record(fixture(), { bearer: "Device unknown" });
  await record(fixture(), { contentType: "text/plain" });
  await record(fixture(), { body: "{}" });
  await record(fixture(), { headers: { "content-length": String(constants.MAX_REQUEST_BYTES + 1) } });
  await record(fixture({ readBoundedRequestBody: async () => { throw new errors.ApiError(408, "BODY_TIMEOUT"); } }), {});
  await record(fixture(), {});
  const steps = registryModule.RETIRED_DEFINITE_PREAMBLE_STEPS[ROUTE_ID];
  assert.deepEqual(observed, [...steps.map(([, status, code]) => [status, code]), [...TERMINAL]]);
});

test("the preamble is closed: a direct call refuses a wrong method; construction refuses a partial dependency set", async () => {
  const f = fixture();
  const direct = await f.preamble(new Request(`${PUBLIC_ORIGIN}${PATH}`, { method: "GET" }));
  assert.equal(direct.status, 405);
  assert.equal(direct.headers.get("allow"), "POST");
  assert.equal((await direct.json()).error.code, "METHOD_NOT_ALLOWED");
  // Outside the root (no registered context) the id is fresh, never a client's.
  const fresh = await f.preamble(new Request(`${PUBLIC_ORIGIN}${PATH}`, { method: "POST",
    headers: { cookie: SESSION_COOKIE, "x-tibotattle-edge-request-id": EDGE_REQUEST_ID } }));
  const freshError = (await fresh.json()).error;
  assert.equal(freshError.code, "AUTH_INVALID");
  assert.notEqual(freshError.requestId, EDGE_REQUEST_ID);
  // An unexpected throw inside is the Worker's 500 INTERNAL_ERROR, never a pass.
  const replay = limiters.createEdgeAdmissionLimiters();
  const valid = {
    requestContext: () => undefined,
    primaryPool: controlsPool({ controls: { enrollment: true, uploadRegistration: true, processing: true,
      publication: true } }),
    schemaOptions: Object.freeze({ primarySchema: "synthetic_primary" }),
    storageGate: { async assertCurrent() {} },
    admissionEnv: admissionEnvOf(replay),
    assertAdmissionBindings: admission.assertAdmissionBindings,
    assertAttemptAllowed: async () => {},
    authenticateAccountlessDevice: async () => { throw new TypeError("synthetic defect"); },
    readBoundedRequestBody: boundedBody.readBoundedRequestBody,
    maxRequestBytes: constants.MAX_REQUEST_BYTES,
    requestShape: requestShape(),
  };
  const broken = testDispatch.createPostgresRetiredPerformanceAuthorizationPreamble(valid);
  const internal = await broken(new Request(`${PUBLIC_ORIGIN}${PATH}`, { method: "POST" }));
  assert.equal(internal.status, 500);
  assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");
  const code = "POSTGRES_RETIRED_PERFORMANCE_AUTHORIZATION_CONFIGURATION_INVALID";
  for (const [name, value] of [
    ["requestContext", undefined],
    ["primaryPool", {}],
    ["storageGate", { probe() {} }],
    ["admissionEnv", { ...valid.admissionEnv }],
    ["assertAdmissionBindings", null],
    ["assertAttemptAllowed", null],
    ["authenticateAccountlessDevice", null],
    ["readBoundedRequestBody", null],
    ["maxRequestBytes", 0],
    ["requestShape", { schemaVersion: "a", policyVersion: "b" }],
    ["requestShape", { ...requestShape(), extra: "c" }],
    ["requestShape", { ...requestShape(), policyVersion: "" }],
  ]) {
    assert.throws(() => testDispatch.createPostgresRetiredPerformanceAuthorizationPreamble({ ...valid, [name]: value }),
      { code }, name);
  }
  assert.throws(() => testDispatch.createPostgresRetiredPerformanceAuthorizationPreamble(), { code });
  assert.throws(() => testDispatch.createPostgresRetiredPerformanceAuthorizationPreamble({ ...valid,
    schemaOptions: { primarySchema: "pg_catalog" } }), { code: "POSTGRES_TEST_SCHEMA_CONFIGURATION_INVALID" });
});
