import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// RD-2 dispatcher (D-CRB) without a database: the Worker preflight runs
// before any read and refuses a missing binding with the Worker's code, the
// single flight shares one evaluation and reuses a completed one for a
// second, a throw is never reused, a wrong method is the Worker's 405, and
// every refusal is the Worker envelope under the root's request id. The
// readers themselves run against PostgreSQL 17 in
// postgres-test/postgres-production-host.spec.mjs. Every value is synthetic.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";

let vite;
let readiness;
let contextModule;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  [readiness, contextModule] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-readiness-dispatch.mjs"),
    vite.ssrLoadModule("/cloud-run/postgres-request-context.mjs"),
  ]);
});

after(async () => {
  await vite?.close();
});

function refusingPool(calls) {
  return {
    async connect() {
      calls.push("connect");
      throw new Error("the preflight must refuse before any database read");
    },
  };
}

function limiter() {
  return Object.freeze({ async limit() { return { success: true }; } });
}

/** A frozen env with every preflight binding and setting, minus `omit`. */
function preflightEnv(omit = [], budget = { async probe() { return true; } }) {
  const env = {
    ENROLLMENT_RATE_LIMIT: limiter(),
    RECOVERY_RATE_LIMIT: limiter(),
    CLIENT_ATTEMPT_RATE_LIMIT: limiter(),
    PUBLIC_READ_RATE_LIMIT: limiter(),
    UPLOAD_AUTHORIZATION_RATE_LIMIT: limiter(),
    UPLOAD_PRINCIPAL_RATE_LIMIT: limiter(),
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT: limiter(),
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT: limiter(),
    UPLOAD_INGRESS_QUEUE_MODE: "disabled",
    UPLOAD_INGRESS_MAX_CONCURRENT: "8",
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "120",
    UPLOAD_INGRESS_BURST: "16",
    UPLOAD_INGRESS_LEASE_SECONDS: "90",
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
    UPLOAD_INGRESS_BUDGET: Object.freeze({ getByName: () => budget }),
    SIGN_IN_START_MAX_PER_MINUTE: "5",
  };
  for (const name of omit) delete env[name];
  return Object.freeze(env);
}

function dispatchFor({ env = preflightEnv(), calls = [], store = contextModule.createRequestContextStore() } = {}) {
  const dispatch = readiness.createPostgresReadinessDispatch({
    requestContext: store.accessor,
    env,
    readinessPool: refusingPool(calls),
    primarySchema: "synthetic_readiness",
    sourceNamespace: "synthetic-namespace",
    expectedPrimaryMigrations: [{ version: 1, name: "0001_schema_metadata.sql", sha256: "a".repeat(64) }],
  });
  return { dispatch, calls, store };
}

async function errorOf(response) {
  const body = await response.json();
  return { status: response.status, code: body.error?.code, requestId: body.error?.requestId,
    cacheControl: response.headers.get("cache-control"), allow: response.headers.get("allow") };
}

test("OD-CR-4: the readiness semantics are Worker-exact", () => {
  assert.equal(readiness.ORIGIN_READINESS_SEMANTICS, "worker-exact");
  assert.equal(readiness.STATUS_REUSE_MILLISECONDS, 1_000);
});

test("the Worker preflight refuses each missing binding or setting before any database read", async () => {
  for (const [omitted, code] of [
    [["ENROLLMENT_RATE_LIMIT"], "ADMISSION_CONFIGURATION_INVALID"],
    [["UPLOAD_PRINCIPAL_RATE_LIMIT"], "ADMISSION_CONFIGURATION_INVALID"],
    [["UPLOAD_INGRESS_CLIENT_RATE_LIMIT"], "ADMISSION_CONFIGURATION_INVALID"],
    [["UPLOAD_INGRESS_BUDGET"], "ADMISSION_CONFIGURATION_INVALID"],
    [["UPLOAD_INGRESS_BODY_TOTAL_SECONDS"], "ADMISSION_CONFIGURATION_INVALID"],
  ]) {
    const { dispatch, calls, store } = dispatchFor({ env: preflightEnv(omitted) });
    const request = new Request("https://tibotattle.test/api/ready");
    const response = await store.dispatch(request, { requestId: REQUEST_ID, routeId: "ready" }, dispatch);
    assert.deepEqual(await errorOf(response), {
      status: 503, code, requestId: REQUEST_ID, cacheControl: "no-store", allow: null,
    }, omitted.join());
    assert.deepEqual(calls, [], `${omitted.join()}: no connection`);
  }
  // An unavailable ingress budget is the Worker's probe answer.
  const down = dispatchFor({ env: preflightEnv([], { async probe() { throw new Error("down"); } }) });
  const answer = await errorOf(await down.dispatch(new Request("https://tibotattle.test/api/ready")));
  assert.equal(answer.status, 503);
  assert.equal(answer.code, "UPLOAD_INGRESS_UNAVAILABLE");
  assert.deepEqual(down.calls, []);
  // With every binding the read runs (and fails closed here: the pool refuses).
  const full = dispatchFor();
  const failed = await full.dispatch(new Request("https://tibotattle.test/api/ready"));
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, "INTERNAL_ERROR");
  assert.deepEqual(full.calls, ["connect"]);
});

test("a wrong method is the Worker's 405 with Allow: GET, before the preflight", async () => {
  const { dispatch, calls } = dispatchFor({ env: preflightEnv(["ENROLLMENT_RATE_LIMIT"]) });
  const answer = await errorOf(await dispatch(new Request("https://tibotattle.test/api/ready", { method: "POST" })));
  assert.equal(answer.status, 405);
  assert.equal(answer.code, "METHOD_NOT_ALLOWED");
  assert.equal(answer.allow, "GET");
  assert.deepEqual(calls, []);
});

test("singleFlight shares one evaluation, reuses a completed one for its window and never reuses a throw", async () => {
  let now = 1_000_000;
  let evaluations = 0;
  let release;
  let fail = false;
  const shared = readiness.singleFlight(async () => {
    evaluations += 1;
    await new Promise((resolveGate) => { release = resolveGate; });
    if (fail) throw new Error("synthetic failure");
    return evaluations;
  }, () => now);
  const concurrent = Array.from({ length: 50 }, () => shared());
  await Promise.resolve();
  release();
  assert.deepEqual(new Set(await Promise.all(concurrent)), new Set([1]));
  assert.equal(evaluations, 1, "50 concurrent callers, one evaluation");
  now += 999;
  assert.equal(await shared(), 1, "reused inside the window");
  assert.equal(evaluations, 1);
  now += 1;
  const next = shared();
  await Promise.resolve();
  release();
  assert.equal(await next, 2, "a new evaluation once the window has passed");
  now += 5_000;
  fail = true;
  const failing = [shared(), shared()];
  await Promise.resolve();
  release();
  for (const outcome of await Promise.allSettled(failing)) assert.equal(outcome.status, "rejected");
  assert.equal(evaluations, 3, "the failing callers shared one evaluation");
  fail = false;
  const recovered = shared();
  await Promise.resolve();
  release();
  assert.equal(await recovered, 4, "a throw is never reused");
  // A clock that moves backwards never extends the window.
  now -= 10_000;
  const again = shared();
  await Promise.resolve();
  release();
  assert.equal(await again, 5);
});

test("construction refuses an incomplete or unfrozen dependency set", () => {
  const base = {
    requestContext: () => undefined,
    env: preflightEnv(),
    readinessPool: refusingPool([]),
    primarySchema: "synthetic_readiness",
    sourceNamespace: "synthetic-namespace",
    expectedPrimaryMigrations: [{ version: 1, name: "0001_schema_metadata.sql", sha256: "a".repeat(64) }],
  };
  assert.equal(typeof readiness.createPostgresReadinessDispatch(base), "function");
  for (const override of [
    { requestContext: undefined },
    { env: { ...preflightEnv() } },
    { readinessPool: {} },
    { primarySchema: 1 },
    { sourceNamespace: null },
    { expectedPrimaryMigrations: [] },
    { clock: "now" },
  ]) {
    assert.throws(() => readiness.createPostgresReadinessDispatch({ ...base, ...override }),
      { code: readiness.READINESS_DISPATCH_CONFIGURATION_INVALID }, Object.keys(override).join());
  }
  assert.throws(() => readiness.createPostgresReadinessDispatch(null),
    { code: readiness.READINESS_DISPATCH_CONFIGURATION_INVALID });
});
