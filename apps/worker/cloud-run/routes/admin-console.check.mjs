/**
 * Storage-free checks of the six admin console route families and the
 * admin-host chokepoint on the PostgreSQL origin (GCP, C-ADMIN).
 *
 * Every storage adapter is a recording stub, so these checks prove the
 * Worker's request preamble (identity, method, CSRF, query and body
 * validation), the closed and unported refusals that must never reach
 * storage, the response envelope, and the ratchets that pin the ported
 * vocabulary to the Worker source in this checkout (route registry,
 * handleAdminAction task keys, actions, reasons and audit fields) and to the
 * EP-0 edge contract. postgres-test/postgres-admin-console.spec.mjs runs the
 * PostgreSQL readers and writers against PostgreSQL 17 and the d43c8f92
 * Worker DTOs.
 *
 * Run: node --test cloud-run/routes/admin-console.check.mjs
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..", "..");
const ORIGIN = "https://admin.example.invalid";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const OWNER = "owner@example.invalid";
const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const TEAM = "synthetic-team.cloudflareaccess.com";
const AUD = "a".repeat(64);

let vite;
let console_;
let access;
let edgeContract;
let routeRegistry;
let errors;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
    resolve: { mainFields: ["module", "main"] },
    ssr: { noExternal: ["jsonc-parser"] },
  });
  console_ = await vite.ssrLoadModule("/cloud-run/routes/admin-console.mjs");
  access = await vite.ssrLoadModule("/src/postgres-admin-access.ts");
  edgeContract = await vite.ssrLoadModule("/src/edge-origin-contract.ts");
  routeRegistry = await vite.ssrLoadModule("/src/route-registry.ts");
  errors = await vite.ssrLoadModule("/src/errors.ts");
});

after(async () => {
  await vite?.close();
});

// ---------------------------------------------------------------------------
// Harness

function contextStore() {
  const contexts = new WeakMap();
  return {
    register(request, identity = OWNER, routeId = "admin_overview") {
      contexts.set(request, Object.freeze({
        requestId: REQUEST_ID,
        routeId,
        ...(identity === null ? {} : { adminIdentityKey: identity }),
      }));
      return request;
    },
    accessor: (request) => contexts.get(request),
  };
}

function recorder() {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    return typeof result === "function" ? result(...args) : result;
  };
  return { calls, record };
}

function adapters(overrides = {}) {
  const { calls, record } = recorder();
  const admin = {
    readOverview: record("readOverview", { schemaVersion: "admin-overview-v0.5" }),
    readAllowancePreview: record("readAllowancePreview", { schemaVersion: "preview" }),
    readDatabaseHealth: record("readDatabaseHealth", { schemaVersion: "admin-database-health-v0.1" }),
    setCollectionControls: record("setCollectionControls", { schemaVersion: "collection-controls-v0.1" }),
    beginAudit: record("beginAudit", "11111111-2222-4333-8444-555555555555"),
    finishAudit: record("finishAudit", undefined),
    finishAuditBestEffort: record("finishAuditBestEffort", undefined),
    maintenance: {},
    ...overrides,
  };
  return { admin, calls };
}

function handlers(admin, store = contextStore()) {
  const map = console_.createAdminConsoleHandlers({
    requestContext: store.accessor,
    clock: () => NOW_MS,
    admin,
  });
  return { map, store };
}

function adminRequest(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}

function actionRequest(body, headers = {}) {
  const merged = {
    "content-type": "application/json",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-usage-monitor-admin": "1",
    ...headers,
  };
  return adminRequest("/api/v1/admin/action", {
    method: "POST",
    headers: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(map, store, routeId, request, identity = OWNER) {
  store.register(request, identity, routeId);
  return map.get(routeId)(request);
}

async function expectError(response, status, code, { allow = null } = {}) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(response.headers.get("allow"), allow);
  assert.deepEqual(await response.json(), { error: { code, requestId: REQUEST_ID } });
}

async function expectOk(response, body) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), body);
}

const GET_ROUTES = Object.freeze([
  ["admin_overview", "/api/v1/admin/overview"],
  ["admin_metrics_history", "/api/v1/admin/metrics/history"],
  ["admin_community_allowance_preview", "/api/v1/admin/community/allowance-preview"],
  ["admin_database_health", "/api/v1/admin/database-health"],
  ["admin_reconstruction_progress", "/api/v1/admin/reconstruction-progress"],
]);

// ---------------------------------------------------------------------------
// Ratchets

test("the six routes equal the registry's admin authority entries", () => {
  const registry = routeRegistry.WORKER_ROUTE_POLICY
    .filter((route) => route.authority === "admin")
    .map((route) => ({ id: route.id, pathname: route.pathname, method: route.methods.join(",") }));
  assert.deepEqual(console_.ADMIN_CONSOLE_ROUTES.map((route) => ({ ...route })), registry);
  assert.equal(registry.length, 6);
  assert.ok(Object.isFrozen(console_.ADMIN_CONSOLE_PATHNAMES));
});

test("handleAdminAction's task keys, actions, reasons and audit fields are ported in the Worker's order", async () => {
  const action = await vite.ssrLoadModule("/cloud-run/routes/admin-action.mjs");
  const index = await readFile(resolve(WORKER_ROOT, "src", "index.ts"), "utf8");
  const start = index.indexOf("async function handleAdminAction(");
  const end = index.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start);
  const handler = index.slice(start, end);
  const taskKeys = [...handler.matchAll(/Object\.hasOwn\(body\.value, "([A-Za-z0-9]+)"\)/gu)].map((m) => m[1]);
  assert.deepEqual([...action.RUN_MAINTENANCE_TASK_KEYS], taskKeys);
  const block = (name) => {
    const at = index.indexOf(`const ${name} = new Set<`);
    return [...index.slice(at, index.indexOf("]);", at)).matchAll(/"([a-z_]+)"/gu)].map((m) => m[1]);
  };
  assert.deepEqual([...action.ADMIN_ACTIONS], block("ADMIN_ACTIONS"));
  assert.deepEqual([...action.ADMIN_CONTROL_REASONS], block("ADMIN_CONTROL_REASONS"));
  const success = handler.indexOf('"success",', handler.indexOf("runScheduledMaintenance(env"));
  const fields = handler.slice(success, handler.indexOf("},", success));
  const auditKeys = [...fields.matchAll(/^\s+([A-Za-z]+):/gmu)].map((m) => m[1]);
  assert.deepEqual([...action.RUN_MAINTENANCE_AUDIT_FIELDS], auditKeys);
});

test("the EP-0 edge contract carries every header the admin routes read to the origin", () => {
  for (const name of ["origin", "sec-fetch-site", "x-usage-monitor-admin", "content-type",
    "content-length", "cookie"]) {
    assert.ok(edgeContract.FORWARDED_REQUEST_HEADERS.includes(name), name);
  }
  assert.deepEqual([...edgeContract.ADMIN_ONLY_FORWARDED_REQUEST_HEADERS], ["cf-access-jwt-assertion"]);
  assert.deepEqual([...edgeContract.EDGE_HOST_KINDS], ["apex", "admin"]);
});

// ---------------------------------------------------------------------------
// Identity and method preamble

test("every route refuses a request without the root's admin identity before anything else", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  for (const [routeId, path] of GET_ROUTES) {
    await expectError(await call(map, store, routeId, adminRequest(path, { method: "PUT" }), null),
      403, "ADMIN_REQUIRED");
  }
  await expectError(await call(map, store, "admin_action", actionRequest({ action: "sync_distribution" }), null),
    403, "ADMIN_REQUIRED");
  // A request the root never registered is refused the same way, under a minted request id.
  const unregistered = await map.get("admin_overview")(adminRequest("/api/v1/admin/overview"));
  assert.equal(unregistered.status, 403);
  const body = await unregistered.json();
  assert.equal(body.error.code, "ADMIN_REQUIRED");
  assert.notEqual(body.error.requestId, REQUEST_ID);
  assert.deepEqual(calls, []);
});

test("each route answers the Worker's 405 with Allow, including HEAD", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  for (const [routeId, path] of GET_ROUTES) {
    for (const method of ["POST", "HEAD", "DELETE"]) {
      await expectError(await call(map, store, routeId, adminRequest(path, { method })),
        405, "METHOD_NOT_ALLOWED", { allow: "GET" });
    }
  }
  for (const method of ["GET", "HEAD", "PUT"]) {
    await expectError(await call(map, store, "admin_action", adminRequest("/api/v1/admin/action", { method })),
      405, "METHOD_NOT_ALLOWED", { allow: "POST" });
  }
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Reads

test("overview validates diagnosticReference and passes the request time", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  for (const bad of ["", "not-a-uuid", "4F2C8A7E-1B3D-4E5F-9A6B-7C8D9E0F1A2B", "4f2c8a7e-1b3d-1e5f-9a6b-7c8d9e0f1a2b"]) {
    await expectError(await call(map, store, "admin_overview",
      adminRequest(`/api/v1/admin/overview?diagnosticReference=${encodeURIComponent(bad)}`)), 400, "BODY_INVALID");
  }
  assert.deepEqual(calls, []);
  await expectOk(await call(map, store, "admin_overview", adminRequest("/api/v1/admin/overview")),
    { schemaVersion: "admin-overview-v0.5" });
  await expectOk(await call(map, store, "admin_overview",
    adminRequest(`/api/v1/admin/overview?diagnosticReference=${REQUEST_ID}&other=1`)),
  { schemaVersion: "admin-overview-v0.5" });
  assert.deepEqual(calls.map((entry) => entry.args[0]), [
    { nowEpoch: NOW_MS },
    { nowEpoch: NOW_MS, diagnosticReference: REQUEST_ID },
  ]);
});

test("an adapter's ApiError is the answer and any other throw is 500 without its message", async () => {
  const { admin } = adapters({
    readOverview: async () => { throw new errors.ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE"); },
    readDatabaseHealth: async () => { throw new Error("driver text that must not leak"); },
  });
  const { map, store } = handlers(admin);
  await expectError(await call(map, store, "admin_overview", adminRequest("/api/v1/admin/overview")),
    503, "COLLECTION_CONTROL_UNAVAILABLE");
  const response = await call(map, store, "admin_database_health", adminRequest("/api/v1/admin/database-health"));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.clone().text(), /driver text/u);
  await expectError(response, 500, "INTERNAL_ERROR");
});

test("metrics history without a GCP source is the Worker's cache-unavailable status, storage-free", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  await expectError(await call(map, store, "admin_metrics_history",
    adminRequest("/api/v1/admin/metrics/history")), 503, "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE");
  assert.deepEqual(calls, []);
  const injected = adapters({ readMetricsHistory: async ({ nowEpoch }) => ({ schemaVersion: "h", nowEpoch }) });
  const second = handlers(injected.admin);
  await expectOk(await call(second.map, second.store, "admin_metrics_history",
    adminRequest("/api/v1/admin/metrics/history")), { schemaVersion: "h", nowEpoch: NOW_MS });
});

test("allowance preview: null is 503 ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE, the query is ignored", async () => {
  const empty = adapters({ readAllowancePreview: async () => null });
  const first = handlers(empty.admin);
  await expectError(await call(first.map, first.store, "admin_community_allowance_preview",
    adminRequest("/api/v1/admin/community/allowance-preview")), 503, "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE");
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  await expectOk(await call(map, store, "admin_community_allowance_preview",
    adminRequest("/api/v1/admin/community/allowance-preview?anything=1")), { schemaVersion: "preview" });
  assert.deepEqual(calls.map((entry) => entry.args[0]), [{ nowEpoch: NOW_MS }]);
});

test("database health refuses any query string", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  for (const query of ["?x", "?x=1", "?=", "?%20"]) {
    await expectError(await call(map, store, "admin_database_health",
      adminRequest(`/api/v1/admin/database-health${query}`)), 400, "BODY_INVALID");
  }
  assert.deepEqual(calls, []);
  // A bare '?' is an empty search, exactly as in the Worker.
  await expectOk(await call(map, store, "admin_database_health", adminRequest("/api/v1/admin/database-health?")),
    { schemaVersion: "admin-database-health-v0.1" });
});

test("reconstruction progress validates its query, then has no GCP source", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  for (const query of ["?detail=other", "?detail", "?detail=preparation&detail=preparation",
    "?detail=preparation&x=1", "?x=1"]) {
    await expectError(await call(map, store, "admin_reconstruction_progress",
      adminRequest(`/api/v1/admin/reconstruction-progress${query}`)), 400, "BODY_INVALID");
  }
  for (const query of ["", "?detail=preparation"]) {
    await expectError(await call(map, store, "admin_reconstruction_progress",
      adminRequest(`/api/v1/admin/reconstruction-progress${query}`)), 503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  assert.deepEqual(calls, []);
  const injected = adapters({ readReconstructionProgress: async (input) => ({ ...input }) });
  const second = handlers(injected.admin);
  await expectOk(await call(second.map, second.store, "admin_reconstruction_progress",
    adminRequest("/api/v1/admin/reconstruction-progress?detail=preparation")),
  { nowEpoch: NOW_MS, includePreparation: true });
});

// ---------------------------------------------------------------------------
// Action

test("admin action enforces the Worker's session-independent CSRF before reading the body", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  const cases = [
    { origin: undefined },
    { origin: "https://example.invalid" },
    { origin: "http://admin.example.invalid" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "x-usage-monitor-admin": undefined },
    { "x-usage-monitor-admin": "true" },
    { "x-usage-monitor-admin": "" },
  ];
  for (const override of cases) {
    const headers = {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-usage-monitor-admin": "1",
      ...override,
    };
    for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name];
    const request = adminRequest("/api/v1/admin/action", {
      method: "POST", headers, body: JSON.stringify({ action: "sync_distribution" }),
    });
    await expectError(await call(map, store, "admin_action", request), 403, "CSRF_INVALID");
    assert.equal(request.bodyUsed, false);
  }
  // Sec-Fetch-Site may be absent.
  const response = await call(map, store, "admin_action",
    actionRequest({ action: "sync_distribution" }, { "sec-fetch-site": undefined }));
  await expectError(response, 503, "POSTGRES_ROUTE_NOT_PORTED");
  assert.deepEqual(calls, []);
});

test("admin action body refusals follow readBoundedJson and the Worker's action checks", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  await expectError(await call(map, store, "admin_action",
    actionRequest({ action: "sync_distribution" }, { "content-type": "text/plain" })), 415, "CONTENT_TYPE_INVALID");
  await expectError(await call(map, store, "admin_action",
    actionRequest({ action: "x" }, { "content-length": "3000000" })), 413, "BODY_TOO_LARGE");
  for (const body of ["{", "[]", "null", "1", "\"run_maintenance\"", JSON.stringify({ action: 1 }),
    JSON.stringify({}), JSON.stringify({ action: "erase" }), JSON.stringify({ action: "RUN_MAINTENANCE" })]) {
    await expectError(await call(map, store, "admin_action", actionRequest(body)), 400, "BODY_INVALID");
  }
  assert.deepEqual(calls, []);
});

test("participantErasure is a closed, storage-free 400 that no injected task can serve", async () => {
  const { admin, calls } = adapters({
    maintenance: { runMaintenance: async () => ({ code: "MAINTENANCE_COMPLETED" }) },
  });
  const { map, store } = handlers(admin);
  for (const body of [
    { action: "run_maintenance", participantErasure: { participantId: "synthetic", confirm: true } },
    { action: "run_maintenance", participantErasure: null },
  ]) {
    await expectError(await call(map, store, "admin_action", actionRequest(body)), 400, "BODY_INVALID");
  }
  assert.deepEqual(calls, []);
  assert.throws(() => handlers(adapters({
    maintenance: { participantErasure: async () => ({}) },
  }).admin), /ADMIN_ROUTE_CONFIGURATION_INVALID/u);
});

test("unported maintenance tasks, the maintenance pass and the sync answer 503 without audit or storage", async () => {
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  for (const body of [
    { action: "run_maintenance" },
    { action: "run_maintenance", telemetryRuntimeActivation: {} },
    { action: "run_maintenance", transportRollback: {} },
    { action: "run_maintenance", v11EvidenceAdoption: { dryRun: true } },
    { action: "sync_distribution" },
  ]) {
    await expectError(await call(map, store, "admin_action", actionRequest(body)), 503, "POSTGRES_ROUTE_NOT_PORTED");
  }
  // Extra keys are refused before the port check, as the Worker refuses them.
  for (const body of [{ action: "run_maintenance", extra: 1 }, { action: "sync_distribution", extra: 1 }]) {
    await expectError(await call(map, store, "admin_action", actionRequest(body)), 400, "BODY_INVALID");
  }
  assert.deepEqual(calls, []);
});

test("an injected task receives the raw body and the owner identity, in the Worker's key order", async () => {
  const seen = [];
  const { admin, calls } = adapters({
    maintenance: {
      telemetryRuntimeActivation: async (input) => { seen.push(["activation", input]); return { code: "A" }; },
      v11EvidenceAdoption: async (input) => { seen.push(["adoption", input]); return { code: "V" }; },
    },
  });
  const { map, store } = handlers(admin);
  const both = { action: "run_maintenance", v11EvidenceAdoption: { dryRun: true }, telemetryRuntimeActivation: {} };
  await expectOk(await call(map, store, "admin_action", actionRequest(both)),
    { schemaVersion: "admin-action-v0.1", action: "run_maintenance", result: { code: "A" } });
  // participantErasure after a ported key never reaches the closed refusal.
  const adoption = { action: "run_maintenance", v11EvidenceAdoption: { dryRun: false }, participantErasure: {} };
  await expectOk(await call(map, store, "admin_action", actionRequest(adoption)),
    { schemaVersion: "admin-action-v0.1", action: "run_maintenance", result: { code: "V" } });
  assert.deepEqual(seen, [
    ["activation", { body: both, identityKey: OWNER }],
    ["adoption", { body: adoption, identityKey: OWNER }],
  ]);
  assert.deepEqual(calls, []);
});

test("the maintenance pass runs between a started and a terminal audit row", async () => {
  const result = { code: "MAINTENANCE_COMPLETED", lifecycleComplete: true, publicationEnabled: true, extra: 7 };
  const { admin, calls } = adapters({ maintenance: { runMaintenance: async () => result } });
  const { map, store } = handlers(admin);
  await expectOk(await call(map, store, "admin_action", actionRequest({ action: "run_maintenance" })),
    { schemaVersion: "admin-action-v0.1", action: "run_maintenance", result });
  assert.deepEqual(calls.map((entry) => entry.name), ["beginAudit", "finishAudit"]);
  assert.deepEqual(calls[0].args[0], {
    action: "run_maintenance", identityKey: OWNER, details: { phase: "started" },
    nowIso: new Date(NOW_MS).toISOString(),
  });
  assert.equal(calls[1].args[0].outcome, "success");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].args[0].details)),
    { code: "MAINTENANCE_COMPLETED", lifecycleComplete: true, publicationEnabled: true });

  const busy = adapters({ maintenance: { runMaintenance: async () => ({ code: "MAINTENANCE_IN_PROGRESS" }) } });
  const second = handlers(busy.admin);
  await expectError(await call(second.map, second.store, "admin_action", actionRequest({ action: "run_maintenance" })),
    409, "LIFECYCLE_STATE_CONFLICT");
  assert.deepEqual(busy.calls.map((entry) => [entry.name, entry.args[0].outcome ?? null,
    entry.args[0].details]), [
    ["beginAudit", null, { phase: "started" }],
    ["finishAuditBestEffort", "failure", { code: "LIFECYCLE_STATE_CONFLICT" }],
  ]);
});

test("an injected distribution sync records the Worker's audit outcomes", async () => {
  const failed = adapters({ maintenance: {
    syncDistribution: async () => ({ code: "GITHUB_SYNC_FAILED", observedAt: null, failureCode: null }),
  } });
  const first = handlers(failed.admin);
  await expectError(await call(first.map, first.store, "admin_action", actionRequest({ action: "sync_distribution" })),
    503, "DISTRIBUTION_SYNC_UNAVAILABLE");
  assert.deepEqual(failed.calls.map((entry) => [entry.name, entry.args[0].outcome ?? null, entry.args[0].details]), [
    ["beginAudit", null, { phase: "started" }],
    ["finishAudit", "failure", { code: "GITHUB_UNAVAILABLE" }],
  ]);
  const synced = { code: "GITHUB_SYNCED", observedAt: "2026-10-02T12:00:00.000Z", failureCode: null };
  const ok = adapters({ maintenance: { syncDistribution: async () => synced } });
  const second = handlers(ok.admin);
  await expectOk(await call(second.map, second.store, "admin_action", actionRequest({ action: "sync_distribution" })),
    { schemaVersion: "admin-action-v0.1", action: "sync_distribution", result: synced });
  assert.deepEqual(ok.calls[1].args[0], {
    operationId: "11111111-2222-4333-8444-555555555555", outcome: "success",
    details: { code: "GITHUB_SYNCED", observedAt: "2026-10-02T12:00:00.000Z" },
  });
});

test("set_collection_controls takes exactly the Worker's closed body", async () => {
  const valid = {
    action: "set_collection_controls", enrollment: true, uploadRegistration: false,
    processing: true, publication: false, reasonCode: "maintenance", expectedRevision: 4,
  };
  const { admin, calls } = adapters();
  const { map, store } = handlers(admin);
  const invalid = [
    { ...valid, extra: 1 },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "publication")),
    { ...valid, enrollment: "true" },
    { ...valid, reasonCode: "initial" },
    { ...valid, reasonCode: "Maintenance" },
    { ...valid, expectedRevision: 0 },
    { ...valid, expectedRevision: 1.5 },
    { ...valid, expectedRevision: "4" },
    { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const body of invalid) {
    await expectError(await call(map, store, "admin_action", actionRequest(body)), 400, "BODY_INVALID");
  }
  assert.deepEqual(calls, []);
  await expectOk(await call(map, store, "admin_action", actionRequest(valid)), {
    schemaVersion: "admin-action-v0.1", action: "set_collection_controls",
    collection: { schemaVersion: "collection-controls-v0.1" },
  });
  assert.deepEqual(calls[0].args[0], {
    identityKey: OWNER,
    flags: { enrollment: true, uploadRegistration: false, processing: true, publication: false },
    reasonCode: "maintenance", expectedRevision: 4, nowEpoch: NOW_MS,
  });
});

test("composition refuses malformed dependencies", () => {
  const { admin } = adapters();
  for (const deps of [
    null,
    { admin },
    { requestContext: () => undefined, clock: 1, admin },
    { requestContext: () => undefined, admin: { ...admin, readOverview: undefined } },
    { requestContext: () => undefined, admin: { ...admin, readMetricsHistory: 1 } },
    { requestContext: () => undefined, admin: { ...admin, maintenance: { unknownTask: async () => ({}) } } },
  ]) {
    assert.throws(() => console_.createAdminConsoleHandlers(deps), /ADMIN_ROUTE_CONFIGURATION_INVALID/u);
  }
  const base = { requestContext: () => undefined, env: Object.freeze({}) };
  for (const deps of [
    { ...base, pools: {}, schemaOptions: { primarySchema: "s" } },
    { ...base, pools: { primary: { connect() {} } }, schemaOptions: {} },
    { ...base, pools: { primary: { connect() {} }, ledger: {} }, schemaOptions: { primarySchema: "s" } },
    { ...base, pools: { primary: { connect() {} }, ledger: { connect() {} } }, schemaOptions: { primarySchema: "s" } },
    { ...base, env: {}, pools: { primary: { connect() {} } }, schemaOptions: { primarySchema: "s" } },
    { ...base, pools: { primary: { connect() {} } }, schemaOptions: { primarySchema: "s" },
      overviewSources: { other: async () => ({}) } },
    // An explicit analytics value must be a pool; null or a non-pool never
    // falls back to the primary default.
    { ...base, pools: { primary: { connect() {} }, analytics: null }, schemaOptions: { primarySchema: "s" } },
    { ...base, pools: { primary: { connect() {} }, analytics: {} }, schemaOptions: { primarySchema: "s" } },
  ]) {
    assert.throws(() => console_.createAdminConsoleAdapters(deps), /ADMIN_ROUTE_CONFIGURATION_INVALID/u);
  }
});

test("database health binds the analytics role to the primary pool by default, never as a fallback", async () => {
  // Each pool counts its connections and refuses them, so every probe is
  // 'unavailable' and no storage is touched.
  const countingPool = () => {
    const pool = { connects: 0, async connect() { pool.connects += 1; throw new Error("synthetic refusal"); } };
    return pool;
  };
  const env = Object.freeze({ TELEMETRY_STORAGE_MODE: "typed",
    TELEMETRY_STORAGE_NAMESPACE: "00000000-0000-4000-8000-0000000000ad" });
  const health = (pools) => console_.createAdminConsoleAdapters({
    requestContext: () => undefined, clock: () => NOW_MS, env, pools,
    schemaOptions: { primarySchema: "s" },
  }).readDatabaseHealth();
  const statuses = (body) => body.databases.map((row) => [row.role, row.status]);

  const primary = countingPool();
  const byDefault = await health({ primary });
  assert.equal(primary.connects, 2, "the primary and analytics roles each probe the primary pool");
  assert.deepEqual(statuses(byDefault),
    [["primary", "unavailable"], ["deletion_ledger", "not_configured"], ["analytics", "unavailable"]]);
  assert.equal(byDefault.status, "degraded");

  const primaryOnly = countingPool();
  const analytics = countingPool();
  const explicit = await health({ primary: primaryOnly, analytics });
  assert.equal(primaryOnly.connects, 1);
  assert.equal(analytics.connects, 1, "an explicit analytics pool is probed as given");
  assert.deepEqual(statuses(explicit), statuses(byDefault));
});

test("the single dispatcher routes by exact pathname only", async () => {
  const { admin } = adapters();
  const store = contextStore();
  const dispatch = console_.createAdminConsoleDispatch({ requestContext: store.accessor, clock: () => NOW_MS, admin });
  assert.equal(dispatch.length, 1);
  const response = await dispatch(store.register(adminRequest("/api/v1/admin/overview")));
  assert.equal(response.status, 200);
  await assert.rejects(dispatch(store.register(adminRequest("/api/v1/admin/overview/"))),
    /ADMIN_ROUTE_CONFIGURATION_INVALID/u);
});

// ---------------------------------------------------------------------------
// Chokepoint

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function signer() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "synthetic-key";
  return {
    jwks: JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256" }] }),
    async token(claims, header = { alg: "RS256", kid }) {
      const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
      const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey,
        new TextEncoder().encode(input));
      return `${input}.${base64url(new Uint8Array(signature))}`;
    },
  };
}

function claims(overrides = {}) {
  const seconds = Math.floor(NOW_MS / 1000);
  return {
    iss: `https://${TEAM}`, aud: [AUD], sub: "synthetic-subject", email: "Owner@Example.Invalid",
    iat: seconds - 60, nbf: seconds - 60, exp: seconds + 600, ...overrides,
  };
}

async function chokepointCode(chokepoint, request) {
  try {
    return await chokepoint(request);
  } catch (error) {
    assert.equal(error?.name, "ApiError");
    return `${error.status} ${error.code}`;
  }
}

test("the chokepoint is the Worker's Access verification and owner pin", async () => {
  const keys = await signer();
  const env = Object.freeze({
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ADMIN_EMAIL: OWNER, ACCESS_TEST_JWKS_JSON: keys.jwks,
  });
  const chokepoint = access.createPostgresAdminAccessChokepoint(env, { allowTestJwks: true, clock: () => NOW_MS });
  const withHeader = async (token) => chokepointCode(chokepoint,
    adminRequest("/api/v1/admin/overview", { headers: { "cf-access-jwt-assertion": token } }));
  assert.equal(await withHeader(await keys.token(claims())), OWNER);
  assert.equal(await chokepointCode(chokepoint, adminRequest("/api/v1/admin/overview", {
    headers: { cookie: `other=1; CF_Authorization=${await keys.token(claims())}` },
  })), OWNER);
  assert.equal(await chokepointCode(chokepoint, adminRequest("/api/v1/admin/overview")), "403 ACCESS_REQUIRED");
  for (const bad of [
    claims({ aud: ["b".repeat(64)] }),
    claims({ iss: "https://other-team.cloudflareaccess.com" }),
    claims({ exp: Math.floor(NOW_MS / 1000) - 3600 }),
    claims({ nbf: Math.floor(NOW_MS / 1000) + 3600 }),
    claims({ sub: undefined }),
  ]) {
    assert.equal(await withHeader(await keys.token(bad)), "403 ACCESS_REQUIRED");
  }
  assert.equal(await withHeader(await keys.token(claims(), { alg: "none", kid: "synthetic-key" })),
    "403 ACCESS_REQUIRED");
  assert.equal(await withHeader(await keys.token(claims(), { alg: "RS256", kid: "unknown" })), "403 ACCESS_REQUIRED");
  const forged = (await keys.token(claims())).split(".");
  forged[1] = base64url(JSON.stringify(claims({ email: "attacker@example.invalid" })));
  assert.equal(await withHeader(forged.join(".")), "403 ACCESS_REQUIRED");
  assert.equal(await withHeader(await keys.token(claims({ email: "someone@example.invalid" }))), "403 ADMIN_REQUIRED");
  assert.equal(await withHeader(await keys.token(claims({ email: undefined }))), "403 ADMIN_REQUIRED");

  const unpinned = access.createPostgresAdminAccessChokepoint(
    Object.freeze({ ...env, ACCESS_ADMIN_EMAIL: undefined }), { allowTestJwks: true, clock: () => NOW_MS });
  assert.equal(await chokepointCode(unpinned, adminRequest("/", {
    headers: { "cf-access-jwt-assertion": await keys.token(claims()) },
  })), "503 ADMIN_NOT_CONFIGURED");
  const unconfigured = access.createPostgresAdminAccessChokepoint(
    Object.freeze({ ...env, ACCESS_AUD: "short" }), { allowTestJwks: true, clock: () => NOW_MS });
  assert.equal(await chokepointCode(unconfigured, adminRequest("/")), "503 ADMIN_NOT_CONFIGURED");
});

test("the chokepoint refuses the Worker's offline key seam unless a test origin opts in", () => {
  const env = Object.freeze({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ADMIN_EMAIL: OWNER,
    ACCESS_TEST_JWKS_JSON: "{\"keys\":[]}" });
  assert.throws(() => access.createPostgresAdminAccessChokepoint(env), {
    code: access.POSTGRES_ADMIN_ACCESS_TEST_JWKS_FORBIDDEN,
  });
  assert.throws(() => access.createPostgresAdminAccessChokepoint(env, { allowTestJwks: "yes" }), {
    code: access.POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID,
  });
  for (const bad of [null, [], "env"]) {
    assert.throws(() => access.createPostgresAdminAccessChokepoint(bad), {
      code: access.POSTGRES_ADMIN_ACCESS_CONFIGURATION_INVALID,
    });
  }
  assert.deepEqual([...access.POSTGRES_ADMIN_ACCESS_ENV_KEYS],
    ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ACCESS_ADMIN_EMAIL"]);
  const production = access.createPostgresAdminAccessChokepoint(
    Object.freeze({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ADMIN_EMAIL: OWNER }));
  assert.equal(production.length, 1);
});
