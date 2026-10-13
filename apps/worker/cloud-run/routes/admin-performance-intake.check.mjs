/**
 * Storage-free checks of the admin performance-intake route
 * (routes/admin-performance-intake.mjs).
 *
 * The source is a recording fake, so these checks prove the admin family
 * preamble (identity first, GET only, no query keys), the 503 for a failing
 * or malformed source, the response envelope and headers, and the
 * configuration refusals. postgres-test/postgres-admin-performance-intake.spec.mjs
 * runs the real reader (src/postgres-admin-performance-intake.ts) against
 * PostgreSQL 17 and drives this route over it. Every value is synthetic.
 *
 * Run: node --test cloud-run/routes/admin-performance-intake.check.mjs
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ORIGIN = "https://admin.example.invalid";
const PATH = "/api/v1/admin/performance-intake";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const OWNER = "owner@example.invalid";
const NOW_MS = Date.parse("2026-10-11T12:00:00.000Z");
const BODY = Object.freeze({ schemaVersion: "admin-performance-intake-v0.1", generatedAt: "2026-10-11T12:00:00.000Z" });

let vite;
let ApiError;
let ADMIN_PERFORMANCE_INTAKE_PATHNAMES;
let ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION;
let createAdminPerformanceIntakeDispatch;

// The route imports src/errors.ts (TypeScript), so it loads through vite,
// as admin-console.check.mjs loads the admin families.
before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom",
    logLevel: "silent",
  });
  const route = await vite.ssrLoadModule("/cloud-run/routes/admin-performance-intake.mjs");
  ({ ApiError } = await vite.ssrLoadModule("/src/errors.ts"));
  ({ ADMIN_PERFORMANCE_INTAKE_PATHNAMES, ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION,
    createAdminPerformanceIntakeDispatch } = route);
});

after(async () => {
  await vite?.close();
});

function harness({ read = async () => BODY, clock = () => NOW_MS } = {}) {
  const contexts = new WeakMap();
  const calls = [];
  const dispatch = createAdminPerformanceIntakeDispatch({
    requestContext: (request) => contexts.get(request),
    clock,
    admin: {
      readPerformanceIntake: async (...args) => {
        calls.push(args);
        return read(...args);
      },
    },
  });
  const send = (path, init = {}, identity = OWNER) => {
    const request = new Request(`${ORIGIN}${path}`, init);
    contexts.set(request, Object.freeze({
      requestId: REQUEST_ID,
      routeId: "admin_performance_intake",
      ...(identity === null ? {} : { adminIdentityKey: identity }),
    }));
    return dispatch(request);
  };
  return { dispatch, send, calls };
}

async function expectError(response, status, code, { allow = null } = {}) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(response.headers.get("allow"), allow);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { error: { code, requestId: REQUEST_ID } });
}

test("the module exports one frozen pathname and the DTO version", () => {
  assert.deepEqual([...ADMIN_PERFORMANCE_INTAKE_PATHNAMES], [PATH]);
  assert.ok(Object.isFrozen(ADMIN_PERFORMANCE_INTAKE_PATHNAMES));
  assert.equal(ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION, "admin-performance-intake-v0.1");
});

test("identity comes first: no registered admin identity is 403 ADMIN_REQUIRED for every method and query", async () => {
  const { send, dispatch, calls } = harness();
  for (const [path, method] of [[PATH, "GET"], [PATH, "POST"], [PATH, "HEAD"], [`${PATH}?x=1`, "GET"],
    [`${PATH}?x=1`, "DELETE"]]) {
    await expectError(await send(path, { method }, null), 403, "ADMIN_REQUIRED");
  }
  // An empty identity is no identity.
  await expectError(await send(PATH, {}, ""), 403, "ADMIN_REQUIRED");
  // A request the root never registered is refused the same way, under a minted request id.
  const unregistered = await dispatch(new Request(`${ORIGIN}${PATH}`));
  assert.equal(unregistered.status, 403);
  const body = await unregistered.json();
  assert.equal(body.error.code, "ADMIN_REQUIRED");
  assert.notEqual(body.error.requestId, REQUEST_ID);
  assert.deepEqual(calls, []);
});

test("every method but GET is 405 METHOD_NOT_ALLOWED with Allow: GET, before the query check", async () => {
  const { send, calls } = harness();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    await expectError(await send(PATH, { method }), 405, "METHOD_NOT_ALLOWED", { allow: "GET" });
    await expectError(await send(`${PATH}?x=1`, { method }), 405, "METHOD_NOT_ALLOWED", { allow: "GET" });
  }
  assert.deepEqual(calls, []);
});

test("any query key is refused 400 BODY_INVALID without reading the source", async () => {
  const { send, calls } = harness();
  for (const query of ["?x", "?x=1", "?=", "?%20", "?nowEpoch=1", "?&"]) {
    await expectError(await send(`${PATH}${query}`), 400, "BODY_INVALID");
  }
  assert.deepEqual(calls, []);
  // A bare '?' is an empty search (WHATWG URL), as for database-health.
  const bare = await send(`${PATH}?`);
  assert.equal(bare.status, 200);
  assert.equal(calls.length, 1);
});

test("200 serves the source's DTO with no-store, vary: Cookie and the JSON security headers", async () => {
  const { send, calls } = harness();
  const response = await send(PATH);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("allow"), null);
  assert.equal(response.headers.get("retry-after"), null);
  assert.deepEqual(await response.json(), BODY);
  // The source receives exactly the request time from the family clock.
  assert.deepEqual(calls, [[{ nowEpoch: NOW_MS }]]);
});

test("a failing source is 503 ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE and its message never leaks", async () => {
  const failures = [
    async () => { throw new Error("driver text that must not leak"); },
    async () => { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); },
    async () => { throw new ApiError(500, "INTERNAL_ERROR"); },
    () => { throw new TypeError("synchronous failure that must not leak"); },
  ];
  for (const read of failures) {
    const { send } = harness({ read });
    const response = await send(PATH);
    assert.doesNotMatch(await response.clone().text(), /leak|driver/u);
    await expectError(response, 503, "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE");
  }
});

test("a body that is not the v0.1 DTO is 503, never served", async () => {
  for (const body of [null, undefined, "text", 1, [], { schemaVersion: "admin-performance-intake-v0.2" }, {},
    { schemaVersion: "admin-overview-v0.6" }, new Map()]) {
    const { send } = harness({ read: async () => body });
    await expectError(await send(PATH), 503, "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE");
  }
});

test("a clock that is not a safe integer is 503 without reading the source", async () => {
  for (const value of [Number.NaN, 1.5, "1", null]) {
    const { send, calls } = harness({ clock: () => value });
    await expectError(await send(PATH), 503, "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE");
    assert.deepEqual(calls, []);
  }
});

test("configuration: deps, requestContext, clock and the source are required", () => {
  const source = { readPerformanceIntake: async () => BODY };
  const context = () => undefined;
  for (const deps of [null, undefined, [], {}, { requestContext: context },
    { requestContext: context, admin: {} }, { requestContext: context, admin: { readPerformanceIntake: BODY } },
    { requestContext: "x", admin: source }, { requestContext: context, admin: source, clock: 1 }]) {
    assert.throws(() => createAdminPerformanceIntakeDispatch(deps),
      (error) => error instanceof TypeError && error.code === "ADMIN_ROUTE_CONFIGURATION_INVALID");
  }
  assert.equal(typeof createAdminPerformanceIntakeDispatch({ requestContext: context, admin: source }), "function");
});

test("the dispatcher takes exactly one argument and the module never logs", async () => {
  const { dispatch } = harness();
  assert.equal(dispatch.length, 1);
  const spies = ["log", "info", "warn", "error", "debug"].map((name) => {
    const original = console[name];
    let calls = 0;
    console[name] = () => { calls += 1; };
    return { name, original, count: () => calls };
  });
  try {
    const { send } = harness({ read: async () => { throw new Error("x"); } });
    await send(PATH);
    await send(PATH, { method: "POST" });
    await send(PATH, {}, null);
  } finally {
    for (const spy of spies) console[spy.name] = spy.original;
  }
  assert.deepEqual(spies.map((spy) => spy.count()), [0, 0, 0, 0, 0]);
});
