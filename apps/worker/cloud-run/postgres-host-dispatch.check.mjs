import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// CR-6 request handler (W3-CRA phase A) without a database: every Worker
// pipeline step over stub families that record their calls, the closed
// unported answer behind the real EP-6 boundary under each admission
// outcome, the request log contract and its redaction, no-store, and the
// loopback private-test pipeline. Every token, key, account and address is
// synthetic; nothing listens and nothing reaches a network.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ORIGIN = "https://tibotattle.test";
const ADMIN_ORIGIN = "https://admin.tibotattle.test";
const EDGE_REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const SAMPLED_REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a00";
const INVOKER = "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const VERIFIER = "origin-verifier@synthetic-edge-0.iam.gserviceaccount.com";
const AUDIENCE = "https://origin.synthetic.example";
const OWNER_EMAIL = "owner@synthetic.example";
const ACCESS_TEAM_DOMAIN = "synthetic.cloudflareaccess.com";
const ACCESS_AUD = "a".repeat(64);
const ACCESS_KID = "synthetic-access-key";
// OD-CR-6(iv) is open and the handler has no default: these checks choose the
// brief's proposed 60 for the fixture and prove the other answers (no header,
// another value) in their own test.
const TEST_UNPORTED_RETRY_AFTER = 60;
// Strings a log line must never carry (D: redaction).
const SECRETS = Object.freeze({
  forwardedFor: "198.51.100.23",
  connectingIp: "203.0.113.77",
  query: "synthetic-query-marker",
  cookie: "synthetic-cookie-marker",
  authorization: "synthetic-authorization-marker",
  access: "synthetic-access-marker",
});

let vite;
let dispatch;
let registryModule;
let contextModule;
let edgeDispatch;
let limiters;
let errors;
let adminUi;
let routeRegistry;
let edgeProxy;
let adminAccess;
let adminChokepoint;
let policy;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  const load = (path) => vite.ssrLoadModule(path);
  [dispatch, registryModule, contextModule, edgeDispatch, limiters, errors, adminUi, routeRegistry,
    edgeProxy, adminAccess, adminChokepoint] = await Promise.all([
    load("/cloud-run/postgres-host-dispatch.mjs"),
    load("/cloud-run/postgres-production-registry.mjs"),
    load("/cloud-run/postgres-request-context.mjs"),
    load("/cloud-run/postgres-edge-origin-dispatch.mjs"),
    load("/cloud-run/postgres-edge-admission-limiters.mjs"),
    load("/src/errors.ts"),
    load("/src/admin-ui.ts"),
    load("/src/route-registry.ts"),
    load("/src/edge-origin-proxy.ts"),
    load("/src/admin-access.ts"),
    load("/src/postgres-admin-access.ts"),
  ]);
  policy = routeRegistry.WORKER_ROUTE_POLICY;
});

after(async () => {
  await vite?.close();
});

// ---------------------------------------------------------------------------
// Fixture

const SCOPE = () => registryModule.POSTGRES_SCOPE_ROUTE_IDS;
const SCOPE_AND_CONTESTED = () => [...registryModule.POSTGRES_SCOPE_ROUTE_IDS,
  ...registryModule.OD_CR_1_CONTESTED_ROUTE_IDS];

function envOf(overrides = {}) {
  return Object.freeze({ PUBLIC_ORIGIN, PUBLIC_ANALYTICS_MODE: "enabled", ...overrides });
}

/**
 * A handler over stub families. families maps a route id to
 * (request, context) => Response | Promise<Response>; every other ported id
 * answers 200 JSON with a public cache-control the handler must replace.
 */
function fixture({
  ported = SCOPE(),
  adminHostPolicy = "refuse",
  env = envOf(),
  families = {},
  storageGate,
  logger,
  recordDiagnostic,
  unportedRetryAfterSeconds = TEST_UNPORTED_RETRY_AFTER,
} = {}) {
  const calls = [];
  const lines = [];
  const diagnostics = [];
  const gateCalls = [];
  const store = contextModule.createRequestContextStore();
  const handlers = new Map(ported.map((id) => [id, async (request) => {
    const context = store.accessor(request);
    calls.push({ id, request, context });
    const family = families[id];
    if (family !== undefined) return family(request, context);
    return Response.json({ served: id }, { headers: { "cache-control": "public, max-age=60" } });
  }]));
  const registry = registryModule.createProductionRouteRegistry({ routePolicy: policy, handlers, portedRouteIds: ported });
  const contexts = new WeakMap();
  const handler = dispatch.createProductionRequestHandler({
    registry,
    env,
    requestContextStore: store,
    requestContext: (request) => contexts.get(request),
    storageGate: storageGate ?? { async assertCurrent() { gateCalls.push(true); } },
    recordDiagnostic: recordDiagnostic ?? (async (event) => { diagnostics.push(event); }),
    logger: logger ?? ((line) => { lines.push(line); }),
    adminHostPolicy,
    // The chokepoint is built once over the env (C-ADMIN); the loopback
    // fixtures alone may honour the test key seam.
    ...(adminHostPolicy === "chokepoint"
      ? { adminAccess: adminChokepoint.createPostgresAdminAccessChokepoint(env, { allowTestJwks: true }) }
      : {}),
    unportedRetryAfterSeconds,
  });
  return {
    handler,
    registry,
    store,
    calls,
    lines,
    diagnostics,
    gateCalls,
    /** A request as EP-6 hands it to inner: with an edge context. */
    edge(request, hostKind = "apex", requestId = EDGE_REQUEST_ID) {
      contexts.set(request, Object.freeze({ requestId, hostKind }));
      return request;
    },
  };
}

function request(path, { method = "GET", origin = PUBLIC_ORIGIN, headers = {}, body } = {}) {
  return new Request(origin + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  });
}

function pathOf(id) {
  return policy.find((route) => route.id === id).pathname;
}

function methodsOf(id) {
  const { methods } = policy.find((route) => route.id === id);
  return methods === "all" ? ["GET", "POST", "DELETE"] : methods;
}

async function errorOf(response) {
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  return body.error;
}

async function assertError(response, status, code, label, { allow, retryAfter, requestId } = {}) {
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", label);
  assert.equal(response.headers.get("allow"), allow ?? null, label);
  assert.equal(response.headers.get("retry-after"), retryAfter ?? null, label);
  const error = await errorOf(response);
  assert.equal(error.code, code, label);
  if (requestId !== undefined) assert.equal(error.requestId, requestId, label);
  else assert.match(error.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, label);
  return error;
}

function parsedLines(lines) {
  return lines.map((line) => {
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed), [...dispatch.ORIGIN_REQUEST_LOG_FIELDS], line);
    return parsed;
  });
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An invoker token as Cloud Run's front end delivers it: signature removed. */
function invokerToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: AUDIENCE, email: INVOKER, email_verified: true, exp: now + 3_000, iat: now - 60,
    iss: "https://accounts.google.com", sub: "100000000000000000000", ...overrides,
  };
  const header = base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" });
  return `Bearer ${header}.${base64UrlJson(payload)}.SIGNATURE_REMOVED_BY_GOOGLE`;
}

async function accessFixture() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: ACCESS_KID, alg: "RS256" };
  async function token(claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${base64UrlJson({ alg: "RS256", kid: ACCESS_KID, typ: "JWT" })}.${base64UrlJson({
      aud: [ACCESS_AUD], email: OWNER_EMAIL, iss: `https://${ACCESS_TEAM_DOMAIN}`, iat: now, nbf: now,
      exp: now + 600, sub: "synthetic-access-subject", ...claims,
    })}`;
    const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey,
      new TextEncoder().encode(input))).toString("base64url");
    return `${input}.${signature}`;
  }
  return {
    env: envOf({
      ACCESS_TEAM_DOMAIN,
      ACCESS_AUD,
      ACCESS_ADMIN_EMAIL: OWNER_EMAIL,
      ACCESS_TEST_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
    }),
    token,
  };
}

// ---------------------------------------------------------------------------
// Constants

test("constants: log contract, admin ids, admin-host policies and the unported answer", () => {
  assert.deepEqual([...dispatch.ORIGIN_REQUEST_LOG_EVENTS], ["request_failed", "request_pending", "request_unavailable"]);
  assert.deepEqual([...dispatch.ORIGIN_REQUEST_LOG_FIELDS],
    ["level", "severity", "event", "requestId", "method", "routeClass", "code", "status"]);
  assert.deepEqual([...dispatch.ORIGIN_ADMIN_HOST_POLICIES], ["refuse", "chokepoint"]);
  // The retry-after is OD-CR-6(iv), injected, so it is not part of the constant.
  assert.deepEqual({ ...dispatch.ORIGIN_ROUTE_NOT_PORTED }, { status: 503, code: "POSTGRES_ROUTE_NOT_PORTED" });
  // handleRequest's six admin ids, as the edge also lists them.
  assert.deepEqual([...dispatch.ORIGIN_ADMIN_ROUTE_IDS].sort(), [...edgeProxy.EDGE_ADMIN_API_ROUTE_IDS].sort());
  for (const value of [dispatch.ORIGIN_REQUEST_LOG_EVENTS, dispatch.ORIGIN_REQUEST_LOG_FIELDS,
    dispatch.ORIGIN_ADMIN_HOST_POLICIES, dispatch.ORIGIN_CONTAINMENT_CODES, dispatch.ORIGIN_UNAVAILABLE_CODES,
    dispatch.ORIGIN_ADMIN_ROUTE_IDS, dispatch.ORIGIN_HANDLER_CONFIGURATION_CODES]) {
    assert.ok(Object.isFrozen(value));
  }
});

test("classifyOriginOutcome follows the Worker's catch classification", () => {
  const cases = [
    ["IDENTITY_RESULT_PENDING", 404, { event: "request_pending", level: "info", diagnostic: false }],
    ...dispatch.ORIGIN_UNAVAILABLE_CODES.map((code) =>
      [code, 503, { event: "request_unavailable", level: "warn", diagnostic: false }]),
    ["PROCESSING_DISABLED", 503, { event: "request_failed", level: "warn", diagnostic: true }],
    ["PUBLICATION_DISABLED", 503, { event: "request_failed", level: "warn", diagnostic: true }],
    ["POSTGRES_ROUTE_NOT_PORTED", 503, { event: "request_failed", level: "warn", diagnostic: false }],
    ["BACKEND_STORAGE_UNAVAILABLE", 503, { event: "request_failed", level: "error", diagnostic: true }],
    ["INTERNAL_ERROR", 500, { event: "request_failed", level: "error", diagnostic: true }],
    ["NOT_FOUND", 404, { event: "request_failed", level: "warn", diagnostic: true }],
    ["UNCLASSIFIED", 502, { event: "request_failed", level: "error", diagnostic: true }],
  ];
  for (const [code, status, expected] of cases) {
    assert.deepEqual({ ...dispatch.classifyOriginOutcome(code, status) }, expected, code);
  }
});

// ---------------------------------------------------------------------------
// Construction refusals (closed codes; OD-CR-3 has no default)

test("createProductionRequestHandler refuses every malformed or undecided input (OD-CR-3, OD-CR-6(iv))", async () => {
  const base = fixture();
  const store = contextModule.createRequestContextStore();
  const valid = {
    registry: base.registry,
    env: envOf(),
    requestContextStore: store,
    requestContext: () => undefined,
    storageGate: { async assertCurrent() {} },
    recordDiagnostic: async () => {},
    adminHostPolicy: "refuse",
    unportedRetryAfterSeconds: TEST_UNPORTED_RETRY_AFTER,
  };
  assert.equal(typeof dispatch.createProductionRequestHandler(valid), "function");
  for (const unportedRetryAfterSeconds of [null, 1, 3600, Number.MAX_SAFE_INTEGER]) {
    assert.equal(typeof dispatch.createProductionRequestHandler({ ...valid, unportedRetryAfterSeconds }), "function");
  }
  const lookalike = registryModule.createProductionRouteRegistry({
    routePolicy: policy.map((route) => ({ ...route })),
    handlers: new Map(SCOPE().map((id) => [id, async () => new Response(null)])),
    portedRouteIds: SCOPE(),
  });
  const cases = [
    ["PRODUCTION_HANDLER_REGISTRY_INVALID", { registry: { ...base.registry } }],
    ["PRODUCTION_HANDLER_REGISTRY_INVALID", { registry: lookalike }],
    ["PRODUCTION_HANDLER_REGISTRY_INVALID", { registry: undefined }],
    ["PRODUCTION_HANDLER_ENV_INVALID", { env: { PUBLIC_ORIGIN } }],
    ["PRODUCTION_HANDLER_ENV_INVALID", { env: envOf({ PUBLIC_ORIGIN: undefined }) }],
    ["PRODUCTION_HANDLER_ENV_INVALID", { env: envOf({ PUBLIC_ORIGIN: "http://tibotattle.test" }) }],
    ["PRODUCTION_HANDLER_ENV_INVALID", { env: envOf({ PUBLIC_ORIGIN: `${PUBLIC_ORIGIN}/` }) }],
    ["PRODUCTION_HANDLER_ENV_INVALID", { env: null }],
    ["PRODUCTION_HANDLER_CONTEXT_STORE_INVALID", { requestContextStore: {} }],
    ["PRODUCTION_HANDLER_REQUEST_CONTEXT_INVALID", { requestContext: undefined }],
    ["PRODUCTION_HANDLER_STORAGE_GATE_INVALID", { storageGate: {} }],
    ["PRODUCTION_HANDLER_STORAGE_GATE_INVALID", { storageGate: undefined }],
    ["PRODUCTION_HANDLER_DIAGNOSTIC_INVALID", { recordDiagnostic: undefined }],
    ["PRODUCTION_HANDLER_LOGGER_INVALID", { logger: "console" }],
    ["PRODUCTION_HANDLER_ADMIN_HOST_POLICY_UNDECIDED", { adminHostPolicy: undefined }],
    ["PRODUCTION_HANDLER_ADMIN_HOST_POLICY_UNDECIDED", { adminHostPolicy: "" }],
    ["PRODUCTION_HANDLER_ADMIN_HOST_POLICY_UNDECIDED", { adminHostPolicy: "allow" }],
    ["PRODUCTION_HANDLER_ADMIN_ACCESS_INVALID", { adminHostPolicy: "chokepoint" }],
    ["PRODUCTION_HANDLER_ADMIN_ACCESS_INVALID", { adminHostPolicy: "chokepoint", adminAccess: {} }],
    ["PRODUCTION_HANDLER_ADMIN_ACCESS_INVALID", { adminAccess: async () => "owner@synthetic.example" }],
    ...[undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "60", true, {}]
      .map((unportedRetryAfterSeconds) =>
        ["PRODUCTION_HANDLER_UNPORTED_RETRY_AFTER_UNDECIDED", { unportedRetryAfterSeconds }]),
  ];
  const { unportedRetryAfterSeconds: _omitted, ...withoutRetryAfter } = valid;
  assert.throws(() => dispatch.createProductionRequestHandler(withoutRetryAfter),
    { code: "PRODUCTION_HANDLER_UNPORTED_RETRY_AFTER_UNDECIDED" }, "an omitted key has no default");
  for (const [code, override] of cases) {
    assert.throws(() => dispatch.createProductionRequestHandler({ ...valid, ...override }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.code, code, JSON.stringify(Object.keys(override)));
      assert.ok(dispatch.ORIGIN_HANDLER_CONFIGURATION_CODES.includes(code));
      return true;
    });
  }
  assert.throws(() => dispatch.createProductionRequestHandler(), { code: "PRODUCTION_HANDLER_REGISTRY_INVALID" });
});

// ---------------------------------------------------------------------------
// The Worker pipeline, step by step

test("step 1: the www alias answers the Worker's 308 before anything else", async () => {
  const f = fixture();
  for (const path of ["/", "/api/health", "/api/v1/contributions?x=1", "/admin"]) {
    const response = await f.handler(f.edge(request(path, { origin: "https://www.tibotattle.test" })));
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get("location"), PUBLIC_ORIGIN + path, path);
    // Worker parity: Response.redirect carries no cache-control.
    assert.equal(response.headers.get("cache-control"), null, path);
  }
  const collapsed = await f.handler(request("//evil.example/x", { origin: "https://www.tibotattle.test" }));
  assert.equal(collapsed.headers.get("location"), `${PUBLIC_ORIGIN}/evil.example/x`);
  assert.equal(f.calls.length, 0);
  assert.equal(f.lines.length, 0);
});

test("step 2, OD-CR-3 'refuse': every admin-host request is the unported 503, before any family", async () => {
  const f = fixture({ ported: SCOPE_AND_CONTESTED() });
  const paths = ["/api/health", "/api/ready", "/api/v1/contributions", "/api/v1/admin/overview", "/admin",
    "/admin.html", "/api/v1/nope", "/"];
  for (const path of paths) {
    for (const method of ["GET", "POST"]) {
      // By the EP-6 host kind, and by the configured admin hostname alone.
      for (const build of [
        () => f.edge(request(path, { method, origin: ADMIN_ORIGIN }), "admin"),
        () => request(path, { method, origin: ADMIN_ORIGIN }),
        () => f.edge(request(path, { method }), "admin"),
      ]) {
        await assertError(await f.handler(build()), 503, "POSTGRES_ROUTE_NOT_PORTED", `${method} ${path}`,
          { retryAfter: String(TEST_UNPORTED_RETRY_AFTER) });
      }
    }
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.gateCalls.length, 0);
  assert.equal(f.diagnostics.length, 0, "the unported answer is not a diagnostic");
  for (const line of parsedLines(f.lines)) {
    assert.equal(line.event, "request_failed");
    assert.equal(line.level, "warn");
    assert.equal(line.code, "POSTGRES_ROUTE_NOT_PORTED");
  }
});

test("step 2, OD-CR-3 'chokepoint': the Access chokepoint first, then the admin families or the generic pipeline", async () => {
  adminAccess.clearAdminAccessJwksCacheForTests();
  // Unconfigured Access fails closed exactly as the Worker does.
  const unconfigured = fixture({ adminHostPolicy: "chokepoint" });
  await assertError(await unconfigured.handler(unconfigured.edge(request("/api/health", { origin: ADMIN_ORIGIN }), "admin")),
    503, "ADMIN_NOT_CONFIGURED", "unconfigured");
  const access = await accessFixture();
  const adminRequest = (f, path, { method = "GET", token } = {}) => f.edge(request(path, {
    method,
    origin: ADMIN_ORIGIN,
    headers: token === undefined ? {} : { "cf-access-jwt-assertion": token },
  }), "admin");
  const owner = await access.token();
  const stranger = await access.token({ email: "stranger@synthetic.example" });

  // The admin family registered (OD-CR-2, C-ADMIN): every admin-host request
  // passes the chokepoint first; an admin id then goes straight to its family
  // with the identity key, for every method (the family answers its own 405).
  const open = fixture({
    adminHostPolicy: "chokepoint",
    env: access.env,
    ported: [...SCOPE_AND_CONTESTED(), ...registryModule.ADMIN_HOST_ROUTE_IDS],
  });
  await assertError(await open.handler(adminRequest(open, "/api/v1/admin/overview")), 403, "ACCESS_REQUIRED", "no token");
  await assertError(await open.handler(adminRequest(open, "/api/v1/admin/overview", { token: "a.b.c" })), 403,
    "ACCESS_REQUIRED", "malformed token");
  await assertError(await open.handler(adminRequest(open, "/api/v1/admin/overview", { token: stranger })), 403,
    "ADMIN_REQUIRED", "valid Access identity, not the owner");
  assert.equal(open.calls.length, 0, "no family runs before the chokepoint admits the owner");
  for (const id of dispatch.ORIGIN_ADMIN_ROUTE_IDS) {
    const [method] = methodsOf(id);
    const wrong = method === "GET" ? "POST" : "GET";
    for (const verb of [method, wrong]) {
      const response = await open.handler(adminRequest(open, pathOf(id), { method: verb, token: owner }));
      assert.equal(response.status, 200, `${id} ${verb}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const call = open.calls.at(-1);
      assert.equal(call.id, id);
      assert.deepEqual({ ...call.context },
        { requestId: EDGE_REQUEST_ID, routeId: id, adminIdentityKey: OWNER_EMAIL }, `${id} ${verb}`);
    }
  }
  // A non-admin route on the admin host falls through to its family, without an identity key.
  const served = await open.handler(adminRequest(open, "/api/health", { token: owner }));
  assert.equal(served.status, 200);
  assert.deepEqual({ ...open.calls.at(-1).context }, { requestId: EDGE_REQUEST_ID, routeId: "health" });
  // An unported route on the admin host is the closed unported answer, after the chokepoint.
  await assertError(await open.handler(adminRequest(open, "/api/v1/me/export", { token: owner })), 503,
    "POSTGRES_ROUTE_NOT_PORTED", "unported on the admin host",
    { retryAfter: String(TEST_UNPORTED_RETRY_AFTER), requestId: EDGE_REQUEST_ID });
  await assertError(await open.handler(adminRequest(open, "/api/v1/me/export")), 403, "ACCESS_REQUIRED",
    "unported on the admin host without a token");
  // The admin UI paths are the edge's to serve: an asset 404 here (documented deviation).
  await assertError(await open.handler(adminRequest(open, "/admin", { token: owner })), 404, "NOT_FOUND", "admin UI",
    { requestId: EDGE_REQUEST_ID });

  // Without the admin family the six ids are unported on the admin host too:
  // the registry method envelope first (as handleRequest's
  // assertWorkerRouteMethod), then the unported answer.
  const closed = fixture({ adminHostPolicy: "chokepoint", env: access.env });
  for (const id of dispatch.ORIGIN_ADMIN_ROUTE_IDS) {
    const [method] = methodsOf(id);
    await assertError(await closed.handler(adminRequest(closed, pathOf(id), { method, token: owner })), 503,
      "POSTGRES_ROUTE_NOT_PORTED", id,
      { retryAfter: String(TEST_UNPORTED_RETRY_AFTER), requestId: EDGE_REQUEST_ID });
    const wrong = method === "GET" ? "POST" : "GET";
    await assertError(await closed.handler(adminRequest(closed, pathOf(id), { method: wrong, token: owner })), 405,
      "METHOD_NOT_ALLOWED", `${id} ${wrong}`, { allow: methodsOf(id).join(", ") });
  }
  assert.equal(closed.calls.length, 0);
});

test("step 3: on the public host, admin paths and the six admin ids are 404 for every method", async () => {
  const f = fixture({ ported: SCOPE_AND_CONTESTED() });
  for (const path of adminUi.ADMIN_SURFACE_PATHS) {
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      const response = await f.handler(f.edge(request(path, { method })));
      assert.equal(response.status, 404, `${method} ${path}`);
      if (method !== "HEAD") await assertError(response, 404, "NOT_FOUND", `${method} ${path}`);
    }
  }
  for (const id of dispatch.ORIGIN_ADMIN_ROUTE_IDS) {
    for (const method of ["GET", "POST", "DELETE", "PUT"]) {
      await assertError(await f.handler(f.edge(request(pathOf(id), { method }))), 404, "NOT_FOUND",
        `${method} ${id}`, { requestId: EDGE_REQUEST_ID });
    }
  }
  assert.equal(f.calls.length, 0);
});

test("step 4: every exact route outside the admin set answers 405 with its exact Allow", async () => {
  const f = fixture({ ported: SCOPE_AND_CONTESTED() });
  for (const route of policy) {
    if (route.methods === "all" || dispatch.ORIGIN_ADMIN_ROUTE_IDS.includes(route.id)) continue;
    const wrongMethods = ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"]
      .filter((method) => !route.methods.includes(method));
    for (const method of wrongMethods) {
      const response = await f.handler(f.edge(request(route.pathname, { method })));
      assert.equal(response.status, 405, `${method} ${route.id}`);
      assert.equal(response.headers.get("allow"), route.methods.join(", "), `${method} ${route.id}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (method !== "HEAD") {
        await assertError(response, 405, "METHOD_NOT_ALLOWED", `${method} ${route.id}`,
          { allow: route.methods.join(", "), requestId: EDGE_REQUEST_ID });
      }
    }
  }
  // The Sparkle appcast guard keeps its POST-only envelope at the origin.
  await assertError(await f.handler(request(pathOf("sparkle_appcast_guard"))), 405, "METHOD_NOT_ALLOWED",
    "appcast GET", { allow: "POST" });
  assert.equal(f.calls.length, 0);
});

test("step 5: community_daily with publication disabled is the Worker's unlogged 503", async () => {
  for (const mode of [undefined, "disabled", "ENABLED"]) {
    const f = fixture({ env: envOf({ PUBLIC_ANALYTICS_MODE: mode }) });
    await assertError(await f.handler(f.edge(request("/api/v1/community/daily?date=2026-10-01"))), 503,
      "PUBLICATION_DISABLED", String(mode), { requestId: EDGE_REQUEST_ID });
    // The method envelope still comes first.
    await assertError(await f.handler(request("/api/v1/community/daily", { method: "POST" })), 405,
      "METHOD_NOT_ALLOWED", "POST", { allow: "GET" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.gateCalls.length, 0);
    assert.equal(parsedLines(f.lines).filter((line) => line.code === "PUBLICATION_DISABLED").length, 0);
  }
});

test("steps 6 and 7: unknown_api, assets, root routes and the retired DELETE /api/v1/me", async () => {
  const f = fixture({ ported: SCOPE_AND_CONTESTED() });
  for (const [path, method] of [["/api/v1/nope", "GET"], ["/api/", "POST"], ["/api/v1/me", "DELETE"],
    ["/api/v1/me", "GET"], ["/api/v1/me/telemetry-v12/effective-page", "GET"]]) {
    await assertError(await f.handler(f.edge(request(path, { method }))), 404, "NOT_FOUND", `${method} ${path}`,
      { requestId: EDGE_REQUEST_ID });
  }
  const unknownLines = parsedLines(f.lines);
  assert.equal(unknownLines.length, 5);
  for (const line of unknownLines) {
    assert.equal(line.routeClass, "unknown_api");
    assert.equal(line.level, "warn");
  }
  f.lines.length = 0;
  // Assets: EP-6's edge-served JSON 404, no-store, unlogged.
  for (const path of ["/", "/index.html", "/privacy.html", "/.well-known/security.txt"]) {
    await assertError(await f.handler(f.edge(request(path))), 404, "NOT_FOUND", path,
      { requestId: EDGE_REQUEST_ID });
  }
  assert.equal(f.lines.length, 0, "an asset 404 is not logged, as the Worker's asset fetch is not");
  // Root routes: Apple for every method, the appcast POST with the guard disabled.
  for (const method of ["GET", "HEAD", "POST", "DELETE", "PUT"]) {
    const response = await f.handler(f.edge(request(pathOf("apple_domain_association"), { method })));
    assert.equal(response.status, 404, method);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  await assertError(await f.handler(f.edge(request(pathOf("sparkle_appcast_guard"), { method: "POST", body: "{}" }))),
    404, "NOT_FOUND", "appcast POST");
  assert.equal(f.calls.length, 0);
});

test("step 7: every unported route answers the closed 503 and reaches no family", async () => {
  for (const ported of [SCOPE(), SCOPE_AND_CONTESTED()]) {
    const f = fixture({ ported });
    for (const id of f.registry.unportedRouteIds) {
      if (dispatch.ORIGIN_ADMIN_ROUTE_IDS.includes(id)) continue;
      for (const method of methodsOf(id)) {
        const error = await assertError(await f.handler(f.edge(request(pathOf(id), {
          method,
          ...(method === "POST" ? { body: "{\"synthetic\":true}", headers: { "content-type": "application/json" } } : {}),
        }))), 503, "POSTGRES_ROUTE_NOT_PORTED", `${method} ${id}`,
        { retryAfter: String(TEST_UNPORTED_RETRY_AFTER), requestId: EDGE_REQUEST_ID });
        assert.deepEqual(Object.keys(error), ["code", "requestId"]);
      }
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.gateCalls.length, 0);
    assert.equal(f.diagnostics.length, 0);
  }
});

test("round 12: every retired route answers the uniform 503 with no retry-after in the production composition", async () => {
  // The production root injects null (OD-CR-6 (iv)); kept and admin routes are served.
  const ported = [...SCOPE_AND_CONTESTED(), ...registryModule.ADMIN_HOST_ROUTE_IDS];
  const f = fixture({ ported, unportedRetryAfterSeconds: null });
  assert.deepEqual([...f.registry.unportedRouteIds], [...registryModule.RETIRED_ROUTE_IDS].sort());
  for (const id of registryModule.RETIRED_ROUTE_IDS) {
    for (const method of methodsOf(id)) {
      const response = await f.handler(f.edge(request(pathOf(id), {
        method,
        ...(method === "POST" ? { body: "{\"synthetic\":true}", headers: { "content-type": "application/json" } } : {}),
      })));
      const error = await assertError(response, 503, "POSTGRES_ROUTE_NOT_PORTED", `${method} ${id}`,
        { requestId: EDGE_REQUEST_ID });
      assert.deepEqual(Object.keys(error), ["code", "requestId"]);
    }
  }
  assert.equal(f.calls.length, 0, "no retired route reaches a family");
  // Each answer is one warn line with the closed code; none is a diagnostic.
  for (const line of parsedLines(f.lines)) {
    assert.deepEqual([line.event, line.level, line.code, line.status],
      ["request_failed", "warn", "POSTGRES_ROUTE_NOT_PORTED", 503]);
  }
  assert.equal(f.diagnostics.length, 0);
  // The kept routes (credential renew, disconnect and every OD-CR-1 session port) still run their family.
  for (const id of ["device_credential_renew", "device_disconnect", "session", "logout", "device_pairing",
    "device_pairing_claim", "participant_devices", "participant_device_revocation", "telemetry_v12_consent"]) {
    const [method] = methodsOf(id);
    const response = await f.handler(f.edge(request(pathOf(id), { method,
      ...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json" } }) })));
    assert.equal(response.status, 200, id);
    assert.deepEqual(await response.json(), { served: id });
  }
});

test("round 12: the accountless performance authorization answers production's definite 403, never a family", async () => {
  const id = "accountless_telemetry_performance_authorization";
  assert.deepEqual(registryModule.RETIRED_DEFINITE_ROUTE_IDS, [id]);
  for (const unportedRetryAfterSeconds of [null, TEST_UNPORTED_RETRY_AFTER]) {
    const f = fixture({ ported: SCOPE_AND_CONTESTED(), unportedRetryAfterSeconds });
    assert.equal(f.registry.unportedRouteIds.includes(id), false);
    // Whatever the caller sends (a valid-looking body, a bearer, a session
    // cookie, no body), the answer is the d43c8f92 terminal code: no
    // retry-after (not even an injected one), the Worker envelope, no-store.
    for (const init of [
      { method: "POST", body: JSON.stringify({ schemaVersion: "accountless-performance-owner-v1",
        policyVersion: "accountless-telemetry-performance-policy-v1",
        authorizationBasis: "accountless-performance-policy-v1" }),
      headers: { "content-type": "application/json", authorization: "Device synthetic.synthetic" } },
      { method: "POST", body: "{}", headers: { "content-type": "application/json", cookie: "__Host-usage_monitor_session=x" } },
      { method: "POST" },
    ]) {
      const response = await f.handler(f.edge(request(pathOf(id), init)));
      const error = await assertError(response, 403, "TELEMETRY_TRANSPORT_BLOCKED", `${id} ${JSON.stringify(init.headers)}`,
        { requestId: EDGE_REQUEST_ID });
      assert.deepEqual(Object.keys(error), ["code", "requestId"]);
    }
    // A wrong method keeps the registry's 405 first, as the Worker answers it.
    await assertError(await f.handler(f.edge(request(pathOf(id), { method: "GET" }))), 405, "METHOD_NOT_ALLOWED",
      `${id} GET`, { allow: "POST", requestId: EDGE_REQUEST_ID });
    assert.equal(f.calls.length, 0);
    assert.equal(f.gateCalls.length, 0, "the definite answer reads no storage");
    // Logged as the Worker logs a 4xx: request_failed at warn; never a sampled 5xx diagnostic.
    const lines = parsedLines(f.lines).filter((line) => line.code === "TELEMETRY_TRANSPORT_BLOCKED");
    assert.equal(lines.length, 3);
    for (const line of lines) assert.deepEqual([line.event, line.level, line.status], ["request_failed", "warn", 403]);
    assert.ok(f.diagnostics.every((event) => event.status < 500));
  }
  // A registry the root built without the definite route cannot exist: it is never portable.
  assert.throws(() => registryModule.createProductionRouteRegistry({ routePolicy: policy,
    portedRouteIds: [...SCOPE(), id], handlers: new Map([...SCOPE(), id].map((routeId) => [routeId, async () => null])) }),
  { code: "PRODUCTION_ROUTE_PORT_RETIRED" });
});

test("OD-CR-6(iv): the unported retry-after is the injected one, or none for null, at both unported sites", async () => {
  for (const [unportedRetryAfterSeconds, expected] of [[null, null], [1, "1"], [3600, "3600"]]) {
    const label = String(unportedRetryAfterSeconds);
    const f = fixture({ unportedRetryAfterSeconds });
    const unported = await f.handler(f.edge(request("/api/v1/enroll", { method: "POST" })));
    const error = await assertError(unported, 503, "POSTGRES_ROUTE_NOT_PORTED", `unported ${label}`,
      { retryAfter: expected ?? undefined, requestId: EDGE_REQUEST_ID });
    assert.deepEqual(Object.keys(error), ["code", "requestId"]);
    await assertError(await f.handler(f.edge(request("/api/health", { origin: ADMIN_ORIGIN }), "admin")), 503,
      "POSTGRES_ROUTE_NOT_PORTED", `admin host ${label}`, { retryAfter: expected ?? undefined });
    assert.equal(f.calls.length, 0);
    assert.equal(f.diagnostics.length, 0);
    assert.equal(f.lines.length, 2);
    for (const line of parsedLines(f.lines)) {
      assert.equal(line.code, "POSTGRES_ROUTE_NOT_PORTED");
      assert.equal(line.level, "warn");
    }
  }
});

test("step 7: a ported route runs its family once, inside the request context, then no-store", async () => {
  const f = fixture({ ported: SCOPE_AND_CONTESTED() });
  for (const id of f.registry.portedRouteIds) {
    const [method] = methodsOf(id);
    const sent = f.edge(request(pathOf(id), { method }));
    const response = await f.handler(sent);
    assert.equal(response.status, 200, id);
    const call = f.calls.at(-1);
    assert.equal(call.id, id);
    assert.equal(call.request, sent, "the family sees the exact Request object");
    assert.deepEqual({ ...call.context }, { requestId: EDGE_REQUEST_ID, routeId: id });
    assert.equal(f.store.accessor(sent), undefined, "the context is released once the family settles");
    if (id === "community_daily") {
      assert.equal(response.headers.get("cache-control"), "public, max-age=60", "200 passes through");
    } else {
      assert.equal(response.headers.get("cache-control"), "no-store", id);
    }
    assert.deepEqual(await response.json(), { served: id });
  }
  assert.equal(f.calls.length, 30);
  assert.equal(f.gateCalls.length, 1, "only community_daily passes the storage gate here");
  // A verifier request (no edge context) gets a fresh v4 id.
  await f.handler(request("/api/health"));
  assert.match(f.calls.at(-1).context.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(f.calls.at(-1).context.requestId, EDGE_REQUEST_ID);
});

test("community_daily: storage gate first; 200 unmodified, anything else no-store", async () => {
  let answer = () => new Response("{}", { status: 200, headers: { "cache-control": "public, max-age=300",
    "content-type": "application/json; charset=utf-8" } });
  const f = fixture({ families: { community_daily: () => answer() } });
  const ok = await f.handler(f.edge(request("/api/v1/community/daily")));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "public, max-age=300");
  answer = () => Response.json({ error: { code: "COMMUNITY_DAILY_UNAVAILABLE", requestId: EDGE_REQUEST_ID } },
    { status: 503, headers: { "cache-control": "public, max-age=300" } });
  const unavailable = await f.handler(f.edge(request("/api/v1/community/daily")));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  answer = () => new Response("{}", { status: 200, headers: { "cache-control": "no-store" } });
  assert.equal((await f.handler(request("/api/v1/community/daily"))).headers.get("cache-control"), "no-store");
  assert.equal(f.gateCalls.length, 3);

  const drift = fixture({
    storageGate: { async assertCurrent() { throw new errors.ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); } },
  });
  await assertError(await drift.handler(drift.edge(request("/api/v1/community/daily"), "apex", SAMPLED_REQUEST_ID)),
    503, "BACKEND_STORAGE_UNAVAILABLE", "receipt drift", { requestId: SAMPLED_REQUEST_ID });
  assert.equal(drift.calls.length, 0, "no family runs on a stale receipt");
  assert.deepEqual(drift.diagnostics, [{ requestId: SAMPLED_REQUEST_ID, routeClass: "community_daily",
    code: "BACKEND_STORAGE_UNAVAILABLE", status: 503 }]);
  assert.equal(parsedLines(drift.lines)[0].level, "error");
  // Other ported routes never call the gate here (families probe it themselves).
  await drift.handler(request("/api/health"));
  assert.equal(drift.calls.length, 1);
  // The real gate throws a plain error carrying status 503 (and a gate that
  // cannot read throws anything): both are the 503, never a 500.
  for (const thrown of [Object.assign(new Error("BACKEND_STORAGE_UNAVAILABLE"),
    { code: "BACKEND_STORAGE_UNAVAILABLE", status: 503 }), new TypeError("synthetic gate failure")]) {
    const plain = fixture({ storageGate: { async assertCurrent() { throw thrown; } } });
    await assertError(await plain.handler(plain.edge(request("/api/v1/community/daily"))),
      503, "BACKEND_STORAGE_UNAVAILABLE", `gate throws ${thrown.name}`, { requestId: EDGE_REQUEST_ID });
    assert.equal(plain.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Errors, logs and diagnostics

test("thrown errors render the Worker envelope; non-ApiError is 500 INTERNAL_ERROR", async () => {
  const thrown = {
    envelope_key: () => { throw new errors.ApiError(429, "RATE_LIMITED", { responseHeaders: { "retry-after": "60" } }); },
    device_sync_state: () => { throw new Error("synthetic driver text that must not leak"); },
    device_sync_manifest: () => "not a response",
    contributions: () => {
      const error = new errors.ApiError(405, "METHOD_NOT_ALLOWED");
      Object.defineProperty(error, "allowed", { value: Object.freeze(["POST"]) });
      throw error;
    },
  };
  const f = fixture({ families: thrown });
  await assertError(await f.handler(f.edge(request("/api/v1/envelope-key"))), 429, "RATE_LIMITED", "429",
    { retryAfter: "60", requestId: EDGE_REQUEST_ID });
  const internal = await f.handler(f.edge(request("/api/v1/device/sync/state")));
  const text = await internal.clone().text();
  assert.doesNotMatch(text, /synthetic driver text/u);
  await assertError(internal, 500, "INTERNAL_ERROR", "plain Error", { requestId: EDGE_REQUEST_ID });
  await assertError(await f.handler(f.edge(request("/api/v1/device/sync/manifest"))), 500, "INTERNAL_ERROR",
    "not a Response");
  await assertError(await f.handler(f.edge(request("/api/v1/contributions", { method: "POST", body: "{}" }))),
    405, "METHOD_NOT_ALLOWED", "allowed", { allow: "POST" });
  const lines = parsedLines(f.lines);
  assert.deepEqual(lines.map((line) => [line.code, line.level, line.status]), [
    ["RATE_LIMITED", "warn", 429],
    ["INTERNAL_ERROR", "error", 500],
    ["INTERNAL_ERROR", "error", 500],
    ["METHOD_NOT_ALLOWED", "warn", 405],
  ]);
});

test("family error responses are classified from a bounded clone; the caller still gets the whole body", async () => {
  const envelope = (status, code) => () => Response.json({ error: { code, requestId: "family-own-id" } }, { status });
  const big = JSON.stringify({ error: { code: "TOO_BIG_TO_READ" }, padding: "x".repeat(9_000) });
  const families = {
    health: envelope(503, "PROCESSING_DISABLED"),
    envelope_key: envelope(500, "INTERNAL_ERROR"),
    device_sync_state: envelope(401, "DEVICE_AUTH_INVALID"),
    device_sync_manifest: envelope(404, "IDENTITY_RESULT_PENDING"),
    device_sync_capabilities: envelope(503, "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE"),
    device_sync_capabilities_v12: () => new Response("upstream text", { status: 502,
      headers: { "content-type": "text/plain" } }),
    telemetry_v11_day_manifests: () => new Response(big, { status: 503,
      headers: { "content-type": "application/json; charset=utf-8" } }),
    telemetry_v12_day_manifests: () => Response.json({ status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" },
      { status: 503 }),
    ready: () => Response.json({ status: "not_ready", checks: {}, policy: {} }, { status: 503 }),
    telemetry_v11_consent: envelope(200, "NOT_AN_ERROR"),
    accountless_renewal: () => Response.json({ error: { code: "lower_case" } }, { status: 400 }),
  };
  const f = fixture({ families });
  const routes = [
    ["/api/health", "GET"],
    ["/api/v1/envelope-key", "GET"],
    ["/api/v1/device/sync/state", "GET"],
    ["/api/v1/device/sync/manifest", "GET"],
    ["/api/v1/device/sync-capabilities", "GET"],
    ["/api/v1/device/sync-capabilities-v1.2", "GET"],
    ["/api/v1/device/telemetry/v1.1/day-manifests", "GET"],
    ["/api/v1/device/telemetry/v1.2/day-manifests", "GET"],
    ["/api/ready", "GET"],
    ["/api/v1/me/device-telemetry-consents", "POST"],
    ["/api/v1/accountless/renewal", "POST"],
  ];
  for (const [path, method] of routes) {
    const response = await f.handler(f.edge(request(path, { method }), "apex", SAMPLED_REQUEST_ID));
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    const text = await response.text();
    if (path.endsWith("v1.1/day-manifests")) assert.equal(text, big, "the full body reaches the caller");
  }
  assert.deepEqual(parsedLines(f.lines).map((line) => [line.routeClass, line.event, line.level, line.code, line.status]), [
    ["health", "request_failed", "warn", "PROCESSING_DISABLED", 503],
    ["envelope_key", "request_failed", "error", "INTERNAL_ERROR", 500],
    ["device_sync_state", "request_failed", "warn", "DEVICE_AUTH_INVALID", 401],
    ["device_sync_manifest", "request_pending", "info", "IDENTITY_RESULT_PENDING", 404],
    ["device_sync_capabilities", "request_unavailable", "warn", "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE", 503],
    ["device_sync_capabilities_v12", "request_failed", "error", "UNCLASSIFIED", 502],
    ["telemetry_v11_day_manifests", "request_failed", "error", "UNCLASSIFIED", 503],
    ["telemetry_v12_day_manifests", "request_failed", "error", "POSTGRES_TEST_ROUTE_UNSUPPORTED", 503],
    ["accountless_renewal", "request_failed", "warn", "UNCLASSIFIED", 400],
  ], "the RD-2 not-ready DTO and a 200 are not logged");
  // Every request_failed reaches the recorder, which applies the Worker's 5xx sampling.
  assert.deepEqual(f.diagnostics.map((event) => [event.routeClass, event.code, event.status]), [
    ["health", "PROCESSING_DISABLED", 503],
    ["envelope_key", "INTERNAL_ERROR", 500],
    ["device_sync_state", "DEVICE_AUTH_INVALID", 401],
    ["device_sync_capabilities_v12", "UNCLASSIFIED", 502],
    ["telemetry_v11_day_manifests", "UNCLASSIFIED", 503],
    ["telemetry_v12_day_manifests", "POSTGRES_TEST_ROUTE_UNSUPPORTED", 503],
    ["accountless_renewal", "UNCLASSIFIED", 400],
  ]);
  for (const event of f.diagnostics) {
    assert.deepEqual(Object.keys(event), ["requestId", "routeClass", "code", "status"]);
    assert.equal(event.requestId, SAMPLED_REQUEST_ID);
  }
  // A ready answer with an error envelope is logged like any other.
  const g = fixture({ families: { ready: envelope(503, "BACKEND_STORAGE_UNAVAILABLE") } });
  await g.handler(request("/api/ready"));
  assert.equal(parsedLines(g.lines)[0].code, "BACKEND_STORAGE_UNAVAILABLE");
});

test("log lines: exactly the eight fields, closed severities and methods, nothing a client sent", async () => {
  const f = fixture({
    families: { envelope_key: () => { throw new errors.ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); } },
  });
  const headers = {
    "x-forwarded-for": SECRETS.forwardedFor,
    "cf-connecting-ip": SECRETS.connectingIp,
    cookie: `__Host-usage_monitor_session=${SECRETS.cookie}`,
    authorization: `Bearer ${SECRETS.authorization}`,
    "cf-access-jwt-assertion": SECRETS.access,
  };
  const query = `?q=${SECRETS.query}`;
  const sent = [
    request(`/api/v1/envelope-key${query}`, { headers }),
    request(`/api/v1/nope${query}`, { headers }),
    request(`/api/v1/admin/overview${query}`, { headers }),
    request(`/api/v1/enroll${query}`, { method: "POST", headers, body: SECRETS.query }),
    request(`/api/health${query}`, { method: "PROPFIND", headers }),
    request(`/api/health${query}`, { method: "PATCH", headers }),
  ];
  for (const item of sent) await f.handler(f.edge(item));
  await f.handler(f.edge(request(`/api/health${query}`, { headers, origin: ADMIN_ORIGIN }), "admin"));
  const lines = parsedLines(f.lines);
  assert.equal(lines.length, 7);
  for (const line of lines) {
    assert.ok(dispatch.ORIGIN_REQUEST_LOG_EVENTS.includes(line.event));
    assert.equal(line.severity, { info: "INFO", warn: "WARNING", error: "ERROR" }[line.level]);
    assert.ok(["GET", "POST", "DELETE", "HEAD", "PUT", "PATCH", "OPTIONS", "OTHER"].includes(line.method));
    assert.equal(line.requestId, EDGE_REQUEST_ID);
    assert.equal(typeof line.status, "number");
  }
  assert.deepEqual(lines.map((line) => line.method), ["GET", "GET", "GET", "POST", "OTHER", "PATCH", "GET"]);
  const all = f.lines.join("\n");
  for (const secret of Object.values(SECRETS)) assert.doesNotMatch(all, new RegExp(secret, "u"));
  assert.doesNotMatch(all, /tibotattle\.test|\/api\/|\?q=/u, "no URL, host or path");
  for (const event of f.diagnostics) {
    assert.doesNotMatch(JSON.stringify(event), new RegExp(Object.values(SECRETS).join("|"), "u"));
  }
});

test("a failing log sink or diagnostic recorder never changes the answer", async () => {
  for (const options of [
    { logger: () => { throw new Error("sink down"); } },
    { recordDiagnostic: async () => { throw new Error("database down"); } },
    { recordDiagnostic: () => { throw new Error("synchronous throw"); } },
  ]) {
    const f = fixture({
      ...options,
      families: { envelope_key: () => { throw new errors.ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); } },
    });
    await assertError(await f.handler(f.edge(request("/api/v1/envelope-key"))), 503, "BACKEND_STORAGE_UNAVAILABLE",
      Object.keys(options)[0], { requestId: EDGE_REQUEST_ID });
    await assertError(await f.handler(f.edge(request("/api/v1/enroll", { method: "POST" }))), 503,
      "POSTGRES_ROUTE_NOT_PORTED", "unported", { retryAfter: String(TEST_UNPORTED_RETRY_AFTER) });
  }
});

test("no-store on every answer except a 200 community_daily (and the Worker's 308)", async () => {
  const f = fixture({ ported: SCOPE_AND_CONTESTED(), families: {
    community_daily: () => new Response("{}", { status: 200, headers: { "cache-control": "public, max-age=300" } }),
  } });
  const samples = [];
  for (const route of policy) {
    for (const method of ["GET", "POST", "HEAD"]) {
      samples.push([route.id, await f.handler(f.edge(request(route.pathname, { method })))]);
    }
  }
  for (const path of ["/", "/api/v1/nope", "/admin"]) samples.push([path, await f.handler(f.edge(request(path)))]);
  for (const [label, response] of samples) {
    const communityOk = label === "community_daily" && response.status === 200;
    assert.equal(response.headers.get("cache-control"), communityOk ? "public, max-age=300" : "no-store", label);
  }
});

// ---------------------------------------------------------------------------
// Behind the real EP-6 boundary

test("behind EP-6, every unported route under every admission outcome is the marked, closed 503", async () => {
  const f = fixture();
  const admission = limiters.createEdgeAdmissionLimiters();
  const handler = dispatch.createProductionRequestHandler({
    registry: f.registry,
    env: envOf(),
    requestContextStore: f.store,
    requestContext: edgeDispatch.edgeRequestContext,
    storageGate: { async assertCurrent() {} },
    recordDiagnostic: async () => {},
    logger: () => {},
    adminHostPolicy: "refuse",
    unportedRetryAfterSeconds: TEST_UNPORTED_RETRY_AFTER,
  });
  const boundary = edgeDispatch.createEdgeOriginDispatch({
    invokerServiceAccount: INVOKER,
    verifierServiceAccounts: [VERIFIER],
    audience: AUDIENCE,
    publicOrigin: PUBLIC_ORIGIN,
    admission,
    inner: handler,
  });
  const raw = (path, { method = "GET", outcome, hostKind = "apex" } = {}) => new Request(
    `https://origin.synthetic.example${path}`, {
      method,
      headers: {
        "x-serverless-authorization": invokerToken(),
        "x-tibotattle-edge-host": hostKind,
        "x-tibotattle-edge-request-id": EDGE_REQUEST_ID,
        ...(outcome === undefined ? {} : { "x-tibotattle-edge-admission": `v1;upload_ingress;${outcome}` }),
      },
    });
  for (const id of f.registry.unportedRouteIds) {
    if (dispatch.ORIGIN_ADMIN_ROUTE_IDS.includes(id)) continue;
    for (const outcome of [undefined, "allowed", "limited", "unavailable"]) {
      const [method] = methodsOf(id);
      const response = await boundary(raw(pathOf(id), { method, outcome }));
      assert.equal(response.headers.get("x-tibotattle-origin"), "1", `${id} ${outcome}`);
      await assertError(response, 503, "POSTGRES_ROUTE_NOT_PORTED", `${id} ${outcome}`,
        { retryAfter: String(TEST_UNPORTED_RETRY_AFTER), requestId: EDGE_REQUEST_ID });
    }
  }
  // Round 12: the retired-definite route answers its 403 under every outcome, marked, never limited.
  for (const id of f.registry.definiteRouteIds) {
    for (const outcome of [undefined, "allowed", "limited", "unavailable"]) {
      const response = await boundary(raw(pathOf(id), { method: "POST", outcome }));
      assert.equal(response.headers.get("x-tibotattle-origin"), "1", `${id} ${outcome}`);
      await assertError(response, 403, "TELEMETRY_TRANSPORT_BLOCKED", `${id} ${outcome}`, { requestId: EDGE_REQUEST_ID });
    }
  }
  // The admin host under 'refuse', marked the same way.
  const admin = await boundary(raw("/api/v1/admin/overview", { hostKind: "admin" }));
  assert.equal(admin.headers.get("x-tibotattle-origin"), "1");
  await assertError(admin, 503, "POSTGRES_ROUTE_NOT_PORTED", "admin host",
    { retryAfter: String(TEST_UNPORTED_RETRY_AFTER) });
  // An asset is EP-6's edgeServedAssets answer, with the edge request id.
  const asset = await boundary(raw("/index.html"));
  const served = await edgeDispatch.edgeServedAssets.fetch(new Request(`${PUBLIC_ORIGIN}/index.html`));
  assert.equal(asset.status, served.status);
  for (const name of ["content-type", "cache-control", "referrer-policy", "x-content-type-options"]) {
    assert.equal(asset.headers.get(name), served.headers.get(name), name);
  }
  assert.equal((await errorOf(served)).code, "NOT_FOUND");
  await assertError(asset, 404, "NOT_FOUND", "asset", { requestId: EDGE_REQUEST_ID });
  // A verifier reads health through the same handler: apex, fresh request id.
  const verified = await boundary(new Request("https://origin.synthetic.example/api/health", {
    headers: { "x-serverless-authorization": invokerToken({ email: VERIFIER }) },
  }));
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get("x-tibotattle-origin"), "1");
  assert.equal(f.calls.length, 1);
  assert.notEqual(f.calls[0].context.requestId, EDGE_REQUEST_ID);
});

// ---------------------------------------------------------------------------
// Loopback private-test pipeline

test("createPrivateTestRequestHandler: ported routes on the dispatch origin, everything else to fallback", async () => {
  const hostOrigin = "http://127.0.0.1:43017";
  const f = fixture();
  const fallen = [];
  const fallback = async (request) => {
    fallen.push(new URL(request.url).pathname);
    return Response.json({ status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" }, { status: 503 });
  };
  const handler = dispatch.createPrivateTestRequestHandler({ registry: f.registry, dispatchOrigin: hostOrigin, fallback });
  // Ported routes keep their own method handling (no 405 at this layer).
  for (const [path, method] of [["/api/health", "GET"], ["/api/health", "POST"], ["/api/v1/contributions", "POST"]]) {
    assert.equal((await handler(request(path, { method, origin: hostOrigin }))).status, 200, path);
  }
  for (const [path, origin] of [["/api/health", PUBLIC_ORIGIN], ["/api/v1/enroll", hostOrigin],
    ["/api/v1/session", hostOrigin], [pathOf("apple_domain_association"), hostOrigin],
    ["/api/v1/nope", hostOrigin], ["/", hostOrigin], ["/api/v1/me/telemetry-v12/effective-page", hostOrigin]]) {
    assert.equal((await handler(request(path, { origin }))).status, 503, path);
  }
  assert.equal(f.calls.length, 3);
  assert.deepEqual(fallen, ["/api/health", "/api/v1/enroll", "/api/v1/session",
    "/.well-known/apple-developer-domain-association.txt", "/api/v1/nope", "/",
    "/api/v1/me/telemetry-v12/effective-page"]);
  for (const [code, options] of [
    ["PRODUCTION_HANDLER_REGISTRY_INVALID", { registry: { ...f.registry } }],
    ["PRIVATE_TEST_HANDLER_ORIGIN_INVALID", { dispatchOrigin: `${hostOrigin}/` }],
    ["PRIVATE_TEST_HANDLER_ORIGIN_INVALID", { dispatchOrigin: undefined }],
    ["PRIVATE_TEST_HANDLER_FALLBACK_INVALID", { fallback: undefined }],
  ]) {
    assert.throws(() => dispatch.createPrivateTestRequestHandler({
      registry: f.registry, dispatchOrigin: hostOrigin, fallback, ...options,
    }), { code });
  }
});
