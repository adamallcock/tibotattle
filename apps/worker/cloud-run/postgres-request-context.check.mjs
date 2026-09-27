import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createRequestContextStore } from "./postgres-request-context.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_ID = "0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4";
const OTHER_REQUEST_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const URL_TEXT = "https://tibotattle.test/api/v1/admin/overview";

let vite;
let contract;
let errors;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  [contract, errors] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-family-contract.mjs"),
    vite.ssrLoadModule("/src/errors.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function request(headers = {}) {
  return new Request(URL_TEXT, { method: "GET", headers });
}

test("the accessor returns context only for the exact registered Request object", () => {
  const store = createRequestContextStore();
  assert.ok(Object.isFrozen(store));
  assert.deepEqual(Object.keys(store).sort(), ["accessor", "dispatch", "register", "release"]);
  const headers = { cookie: "a=b", "x-usage-monitor-admin": "1" };
  const original = request(headers);
  const supplied = { requestId: REQUEST_ID, routeId: "admin_overview", adminIdentityKey: "owner@example.test" };
  const registered = store.register(original, supplied);
  assert.notEqual(registered, supplied, "the store keeps its own copy");
  const { accessor } = store;
  assert.equal(accessor(original), registered);
  assert.deepEqual(accessor(original), supplied);
  assert.equal(accessor(original.clone()), undefined);
  assert.equal(accessor(request(headers)), undefined);
  assert.equal(accessor(new Request(original)), undefined);
  for (const primitive of [undefined, null, 0, "x", URL_TEXT, Symbol("request")]) {
    assert.equal(accessor(primitive), undefined);
  }
  supplied.adminIdentityKey = "attacker@example.test";
  assert.equal(accessor(original).adminIdentityKey, "owner@example.test");
});

test("contexts are frozen, closed and validated before registration", () => {
  const store = createRequestContextStore();
  const target = request();
  const context = store.register(target, { requestId: REQUEST_ID, routeId: "health" });
  assert.ok(Object.isFrozen(context));
  assert.deepEqual(Object.keys(context), ["requestId", "routeId"]);
  assert.equal(Object.hasOwn(context, "adminIdentityKey"), false);
  assert.throws(() => { context.adminIdentityKey = "owner@example.test"; }, TypeError);
  assert.throws(() => store.register(target, { requestId: OTHER_REQUEST_ID, routeId: "health" }),
    { code: "REQUEST_CONTEXT_ALREADY_REGISTERED" });
  assert.equal(store.accessor(target).requestId, REQUEST_ID);

  class ContextLike {
    constructor() {
      this.requestId = REQUEST_ID;
      this.routeId = "health";
    }
  }
  for (const [candidate, code] of [
    [null, "REQUEST_CONTEXT_INVALID"],
    [[REQUEST_ID], "REQUEST_CONTEXT_INVALID"],
    [new ContextLike(), "REQUEST_CONTEXT_INVALID"],
    [{ requestId: REQUEST_ID, routeId: "health", clientAddress: "203.0.113.9" }, "REQUEST_CONTEXT_INVALID"],
    [{ requestId: REQUEST_ID, routeId: "health", [Symbol("x")]: 1 }, "REQUEST_CONTEXT_INVALID"],
    [{ routeId: "health" }, "REQUEST_CONTEXT_REQUEST_ID_INVALID"],
    [{ requestId: REQUEST_ID.toUpperCase(), routeId: "health" }, "REQUEST_CONTEXT_REQUEST_ID_INVALID"],
    [{ requestId: "0b6f1d2e-3c4a-1b5c-8d6e-7f8091a2b3c4", routeId: "health" }, "REQUEST_CONTEXT_REQUEST_ID_INVALID"],
    [{ requestId: REQUEST_ID }, "REQUEST_CONTEXT_ROUTE_ID_INVALID"],
    [{ requestId: REQUEST_ID, routeId: "Admin Overview" }, "REQUEST_CONTEXT_ROUTE_ID_INVALID"],
    [{ requestId: REQUEST_ID, routeId: "health", adminIdentityKey: "" }, "REQUEST_CONTEXT_ADMIN_IDENTITY_INVALID"],
    [{ requestId: REQUEST_ID, routeId: "health", adminIdentityKey: undefined }, "REQUEST_CONTEXT_ADMIN_IDENTITY_INVALID"],
    [{ requestId: REQUEST_ID, routeId: "health", adminIdentityKey: "x".repeat(513) }, "REQUEST_CONTEXT_ADMIN_IDENTITY_INVALID"],
  ]) {
    const fresh = request();
    assert.throws(() => store.register(fresh, candidate), { name: "TypeError", code });
    assert.equal(store.accessor(fresh), undefined);
  }
  for (const notARequest of [{ url: URL_TEXT, headers: new Headers() }, URL_TEXT, null]) {
    assert.throws(() => store.register(notARequest, { requestId: REQUEST_ID, routeId: "health" }),
      { code: "REQUEST_CONTEXT_REQUEST_INVALID" });
  }
});

test("release removes the entry and stores are isolated from each other", () => {
  const first = createRequestContextStore();
  const second = createRequestContextStore();
  const target = request();
  first.register(target, { requestId: REQUEST_ID, routeId: "session" });
  assert.equal(second.accessor(target), undefined);
  second.register(target, { requestId: OTHER_REQUEST_ID, routeId: "session" });
  assert.equal(first.accessor(target).requestId, REQUEST_ID);
  assert.equal(second.accessor(target).requestId, OTHER_REQUEST_ID);
  assert.equal(first.release(target), true);
  assert.equal(first.accessor(target), undefined);
  assert.equal(first.release(target), false);
  assert.equal(first.release("not a request"), false);
  assert.equal(second.accessor(target).requestId, OTHER_REQUEST_ID);
});

test("dispatch calls the dispatcher with exactly one argument and releases after it settles", async () => {
  const store = createRequestContextStore();
  const target = request();
  const seen = [];
  const response = await store.dispatch(target, { requestId: REQUEST_ID, routeId: "session" }, function stub(...args) {
    seen.push(args.length, args[0] === target, store.accessor(args[0])?.requestId);
    return Promise.resolve(new Response("ok"));
  });
  assert.deepEqual(seen, [1, true, REQUEST_ID]);
  assert.equal(await response.text(), "ok");
  assert.equal(store.accessor(target), undefined);

  const failing = request();
  const failure = new Error("family failure");
  await assert.rejects(store.dispatch(failing, { requestId: REQUEST_ID, routeId: "session" }, async (only) => {
    assert.equal(store.accessor(only)?.routeId, "session");
    throw failure;
  }), (error) => error === failure);
  assert.equal(store.accessor(failing), undefined);

  const unregistered = request();
  await assert.rejects(store.dispatch(unregistered, { requestId: "bad", routeId: "session" }, async () => new Response("")),
    { code: "REQUEST_CONTEXT_REQUEST_ID_INVALID" });
  await assert.rejects(store.dispatch(unregistered, { requestId: REQUEST_ID, routeId: "session" }, "not a function"),
    { code: "REQUEST_CONTEXT_DISPATCHER_INVALID" });
  assert.equal(store.accessor(unregistered), undefined);
});

test("identity headers never populate adminIdentityKey; only the registered context does", () => {
  const store = createRequestContextStore();
  const deps = Object.freeze({ requestContext: store.accessor });
  const spoofed = request({
    "x-admin-identity": "owner@example.test",
    "cf-access-authenticated-user-email": "owner@example.test",
    "cf-access-jwt-assertion": "header.payload.signature",
    "x-tibotattle-edge-request-id": OTHER_REQUEST_ID,
  });
  assert.equal(contract.adminIdentityFor(deps, spoofed), null);
  assert.notEqual(contract.requestIdFor(deps, spoofed), OTHER_REQUEST_ID);
  store.register(spoofed, { requestId: REQUEST_ID, routeId: "admin_overview" });
  assert.equal(contract.adminIdentityFor(deps, spoofed), null);
  assert.equal(contract.requestIdFor(deps, spoofed), REQUEST_ID);

  const verified = request();
  store.register(verified, {
    requestId: OTHER_REQUEST_ID,
    routeId: "admin_overview",
    adminIdentityKey: "owner@example.test",
  });
  assert.equal(contract.adminIdentityFor(deps, verified), "owner@example.test");
  assert.equal(contract.adminIdentityFor(deps, verified.clone()), null);
});

test("a family stub uses the root requestId in its envelope and refuses admin work without identity", async () => {
  const store = createRequestContextStore();
  const deps = Object.freeze({ requestContext: store.accessor });
  const createStubAdminDispatch = (familyDeps) => async (incoming) => {
    const requestId = contract.requestIdFor(familyDeps, incoming);
    try {
      if (contract.adminIdentityFor(familyDeps, incoming) === null) {
        throw new errors.ApiError(403, "ADMIN_REQUIRED");
      }
      return contract.workerJson(200, { ok: true });
    } catch (error) {
      return contract.apiErrorToResponse(error, requestId);
    }
  };
  const dispatcher = contract.assertDispatcher(createStubAdminDispatch(deps));

  const refused = await store.dispatch(request(), { requestId: REQUEST_ID, routeId: "admin_overview" }, dispatcher);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: { code: "ADMIN_REQUIRED", requestId: REQUEST_ID } });

  const allowed = await store.dispatch(request(), {
    requestId: OTHER_REQUEST_ID,
    routeId: "admin_overview",
    adminIdentityKey: "owner@example.test",
  }, dispatcher);
  assert.equal(allowed.status, 200);

  const unregistered = await createStubAdminDispatch({ requestContext: () => undefined })(request());
  assert.equal(unregistered.status, 403);
  const body = await unregistered.json();
  assert.equal(body.error.code, "ADMIN_REQUIRED");
  assert.match(body.error.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
