import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  identityDigest,
  openOperation,
  readOperation,
} from "../../../scripts/lib/release-operation.mjs";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import {
  captureTelemetryRuntimeReconciliation,
  parseTelemetryRuntimeActivationOperatorArguments,
  parseTelemetryRuntimeReconciliationArguments,
  runProtectedTelemetryRuntimeActivation,
  TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA,
} from "./telemetry-runtime-reconciliation.mjs";
import { TYPED_PRODUCTION_QUERIES } from "./production-typed-preflight.mjs";

const ACCOUNT = "a".repeat(32);
const SOURCE = "b".repeat(40);
const VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIMARY = "11111111-1111-4111-8111-111111111111";
const ANALYTICS = "22222222-2222-4222-8222-222222222222";
const LEDGER = "33333333-3333-4333-8333-333333333333";
const WORKER = "synthetic-worker";
const bindings = [
  { name: "USAGE_MONITOR_DB", type: "d1", id: PRIMARY, database_id: PRIMARY },
  { name: "ANALYTICS_DB", type: "d1", id: ANALYTICS, database_id: ANALYTICS },
  { name: "DELETION_LEDGER", type: "d1", id: LEDGER, database_id: LEDGER },
  { name: "ASSETS", type: "assets" },
  { name: "PUBLIC_ORIGIN", type: "plain_text", text: "https://synthetic.example" },
  { name: "DEPLOYMENT_SOURCE_COMMIT", type: "plain_text", text: SOURCE },
];
const runtime = {
  migration_tag: "upload-ingress-budget-v1",
  assets: { not_found_handling: "404-page", raw_run_worker_first: true, serve_directly: false },
  compatibility_date: "2026-07-26",
  compatibility_flags: ["nodejs_compat"],
  limits: { cpu_ms: 300000 },
  usage_model: "standard",
  cache_options: { enabled: true, cross_version_cache: false },
};
const settings = {
  placement: {},
  compatibility_date: runtime.compatibility_date,
  compatibility_flags: runtime.compatibility_flags,
  usage_model: runtime.usage_model,
  tags: [],
  tail_consumers: [],
  logpush: false,
  limits: runtime.limits,
  observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true },
  annotations: {},
  cache_options: runtime.cache_options,
  bindings,
};
const schemaRows = (role) => [{
  type: "table",
  name: `${role}_schema`,
  tbl_name: `${role}_schema`,
  sql: `CREATE TABLE ${role}_schema(id INTEGER PRIMARY KEY)`,
}];
const ledgerRows = [{ name: "0024_synthetic.sql", sha256: "c".repeat(64) }];

test("requires the exact owner-private output arguments", () => {
  assert.deepEqual(parseTelemetryRuntimeReconciliationArguments([
    "--account-id", ACCOUNT,
    "--worker-name", WORKER,
    "--output", "/private/tmp/telemetry-proof.json",
  ]), {
    "--account-id": ACCOUNT,
    "--worker-name": WORKER,
    "--output": "/private/tmp/telemetry-proof.json",
  });
  for (const args of [
    ["--account-id", "bad", "--worker-name", WORKER, "--output", "/private/tmp/proof.json"],
    ["--account-id", ACCOUNT, "--worker-name", WORKER, "--output", "relative.json"],
    ["--account-id", ACCOUNT, "--worker-name", WORKER, "--output", "/private/tmp/proof.json", "--output", "/private/tmp/other.json"],
  ]) {
    assert.throws(() => parseTelemetryRuntimeReconciliationArguments(args), {
      code: "TELEMETRY_RUNTIME_RECONCILIATION_ARGUMENTS_INVALID",
    });
  }
});

test("requires the maintained activation operator arguments", () => {
  assert.deepEqual(parseTelemetryRuntimeActivationOperatorArguments([
    "--account-id", ACCOUNT,
    "--worker-name", WORKER,
    "--repository-root", "/private/tmp/checkout",
    "--operation-directory", "/private/tmp/activation-operation",
    "--request-file", "/private/tmp/activation-request.json",
    "--admin-session-file", "/private/tmp/admin-session.json",
    "--resume",
  ]), {
    "--account-id": ACCOUNT,
    "--worker-name": WORKER,
    "--repository-root": "/private/tmp/checkout",
    "--operation-directory": "/private/tmp/activation-operation",
    "--request-file": "/private/tmp/activation-request.json",
    "--admin-session-file": "/private/tmp/admin-session.json",
    resume: true,
  });
  assert.throws(() => parseTelemetryRuntimeActivationOperatorArguments([
    "--account-id", ACCOUNT,
    "--worker-name", WORKER,
    "--repository-root", "/private/tmp/checkout",
    "--operation-directory", "/private/tmp/activation-operation",
    "--request-file", "/private/tmp/activation-request.json",
    "--admin-session-file", "/private/tmp/admin-session.json",
    "--resume", "true",
  ]), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ARGUMENTS_INVALID" });
  assert.deepEqual(parseTelemetryRuntimeActivationOperatorArguments([
    "--account-id", ACCOUNT,
    "--worker-name", WORKER,
    "--repository-root", "/private/tmp/checkout",
    "--operation-directory", "/private/tmp/activation-operation",
    "--request-file", "/private/tmp/activation-request.json",
  ]), {
    "--account-id": ACCOUNT,
    "--worker-name": WORKER,
    "--repository-root": "/private/tmp/checkout",
    "--operation-directory": "/private/tmp/activation-operation",
    "--request-file": "/private/tmp/activation-request.json",
    resume: false,
  });
});

function inventory(versionId = VERSION, sourceCommit = SOURCE) {
  const localBindings = bindings.map((binding) => binding.name === "DEPLOYMENT_SOURCE_COMMIT"
    ? { ...binding, text: sourceCommit }
    : binding);
  const localSettings = { ...settings, bindings: localBindings };
  return {
    capturedAt: "2026-09-22T15:00:00.000Z",
    accountId: ACCOUNT,
    workerName: WORKER,
    version: { id: versionId, resources: { script_runtime: runtime, bindings: localBindings } },
    settings: localSettings,
    schedules: { schedules: [] },
    subdomain: { enabled: false, previews_enabled: false },
    routes: [],
    domains: [],
    namespaces: [],
  };
}

function fixtureFetch(driftRole = null) {
  const calls = [];
  const queryCounts = new Map();
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/deployments")) {
      return Response.json({ success: true, result: {
        deployments: [{ versions: [{ version_id: VERSION, percentage: 100 }] }],
      } });
    }
    if (parsed.pathname.endsWith(`/versions/${VERSION}`)) {
      return Response.json({ success: true, result: inventory().version });
    }
    if (parsed.pathname.endsWith("/settings")) return Response.json({ success: true, result: settings });
    if (parsed.pathname.endsWith("/schedules")) return Response.json({ success: true, result: { schedules: [] } });
    if (parsed.pathname.endsWith("/subdomain")) return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
    if (parsed.pathname.endsWith("/routes") || parsed.pathname.endsWith("/records")
        || parsed.pathname.endsWith("/namespaces")) return Response.json({ success: true, result: [] });
    if (parsed.pathname.includes("/d1/database/")) {
      const query = JSON.parse(options.body).sql;
      const databaseId = parsed.pathname.split("/").at(-2);
      const role = databaseId === PRIMARY ? "primary" : databaseId === ANALYTICS ? "analytics" : "ledger";
      const key = `${role}:${query}`;
      queryCounts.set(key, (queryCounts.get(key) ?? 0) + 1);
      const rows = query === TYPED_PRODUCTION_QUERIES.schema
        ? schemaRows(role).concat(driftRole === role && queryCounts.get(key) >= 2
          ? [{ type: "table", name: "drift_schema", tbl_name: "drift_schema", sql: "CREATE TABLE drift_schema(id INTEGER)" }]
          : [])
        : query === TYPED_PRODUCTION_QUERIES.ledger ? ledgerRows : null;
      assert.ok(rows, `unexpected query: ${query}`);
      assert.match(query, /^SELECT\b/iu);
      return Response.json({ success: true, result: [{ success: true, results: rows }] });
    }
    throw new Error("unexpected synthetic URL");
  };
  return { calls, fakeFetch };
}

async function runFixture(driftRole = null) {
  const root = await mkdtemp("/private/tmp/telemetry-runtime-reconciliation-");
  await chmod(root, 0o700);
  const output = join(root, "proof.json");
  const fixture = fixtureFetch(driftRole);
  try {
    const proof = await captureTelemetryRuntimeReconciliation({
      accountId: ACCOUNT,
      workerName: WORKER,
      output,
      environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
      fetchImpl: fixture.fakeFetch,
      now: () => "2026-09-22T15:00:00.000Z",
    });
    return {
      proof,
      output,
      fixture,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("captures both roles, rechecks the Worker, and writes a private read-only proof", async () => {
  const result = await runFixture();
  try {
    const { proof, output, fixture } = result;
    assert.equal(proof.schema, TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA);
    assert.equal(proof.sourceCommit, SOURCE);
    assert.equal(proof.versionId, VERSION);
    assert.match(proof.proofSha256, /^[a-f0-9]{64}$/u);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), proof);
    assert.equal(fixture.calls.filter((call) => call.options.method === "POST").length, 8);
    assert.ok(fixture.calls.filter((call) => call.options.method === "POST")
      .every((call) => JSON.parse(call.options.body).sql.startsWith("SELECT")));
    const { proofSha256, ...unsigned } = proof;
    assert.equal(identityDigest(unsigned), proofSha256);
    await assert.rejects(captureTelemetryRuntimeReconciliation({
      accountId: ACCOUNT,
      workerName: WORKER,
      output,
      environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
      fetchImpl: () => assert.fail("existing receipts must refuse before network use"),
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_OUTPUT_EXISTS" });
  } finally {
    await result.cleanup();
  }
});

for (const role of ["primary", "analytics"]) {
  test(`refuses a ${role} schema change between role reads`, async () => {
    await assert.rejects(runFixture(role), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ROLE_CHANGED" });
  });
}

for (const [role, databaseId] of [["primary", PRIMARY], ["analytics", ANALYTICS]]) {
  for (const count of [128, 129]) {
    test(`${role} reconciliation ${count === 128 ? "accepts the ledger boundary" : "refuses the overflow sentinel"}`, async () => {
      const root = await mkdtemp("/private/tmp/telemetry-runtime-ledger-boundary-");
      await chmod(root, 0o700);
      const output = join(root, "proof.json");
      const fixture = fixtureFetch();
      const fetchImpl = async (url, options) => {
        if (new URL(url).pathname.endsWith(`/d1/database/${databaseId}/query`)
            && JSON.parse(options.body).sql === TYPED_PRODUCTION_QUERIES.ledger) {
          return Response.json({ success: true, result: [{ success: true,
            results: Array.from({ length: count }, (_, index) => ({
              name: `migration-${index}`, sha256: "a".repeat(64),
            })),
          }] });
        }
        return fixture.fakeFetch(url, options);
      };
      try {
        const capture = captureTelemetryRuntimeReconciliation({
          accountId: ACCOUNT, workerName: WORKER, output,
          environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
          fetchImpl, now: () => "2026-09-22T15:00:00.000Z",
        });
        if (count === 128) {
          const proof = await capture;
          assert.equal(JSON.parse(await readFile(output, "utf8")).proofSha256, proof.proofSha256);
        } else {
          await assert.rejects(capture, { code: "TELEMETRY_RUNTIME_RECONCILIATION_QUERY_RESULT_INVALID" });
          await assert.rejects(readFile(output), { code: "ENOENT" });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("publishes one receipt when concurrent writers race for the same destination", async () => {
  const root = await mkdtemp("/private/tmp/telemetry-runtime-reconciliation-race-");
  await chmod(root, 0o700);
  const output = join(root, "proof.json");
  const makeCapture = () => captureTelemetryRuntimeReconciliation({
    accountId: ACCOUNT,
    workerName: WORKER,
    output,
    environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
    fetchImpl: fixtureFetch().fakeFetch,
    now: () => "2026-09-22T15:00:00.000Z",
  });
  try {
    const results = await Promise.allSettled([makeCapture(), makeCapture()]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.reason?.code, "TELEMETRY_RUNTIME_RECONCILIATION_OUTPUT_EXISTS");
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function activationRequest(proof, idempotencyKey = "44444444-4444-4444-8444-444444444444") {
  return {
    action: "run_maintenance",
    telemetryRuntimeActivation: {
      target: "usage_v12",
      expectedRevision: 1,
      confirmation: "activate_telemetry_v12_runtime",
      idempotencyKey,
      reconciliation: proof,
    },
  };
}

function adminSession() {
  return {
    schema: "telemetry-runtime-admin-session-v1",
    origin: DEPLOYMENT_ENDPOINTS.admin.origin,
    cookie: "CF_Authorization=synthetic-owner-session; __Host-usage_monitor_session=synthetic-app-session",
    csrfToken: "synthetic-csrf-token",
    accessJwt: "synthetic-access-jwt",
  };
}

function resultFor(request) {
  const activation = request.telemetryRuntimeActivation;
  return {
    task: "telemetry_runtime_activation",
    operationId: activation.idempotencyKey,
    target: activation.target,
    state: "active",
    fromRevision: activation.expectedRevision,
    toRevision: activation.expectedRevision + 1,
    revision: activation.expectedRevision + 1,
  };
}

function operationHarness() {
  const id = "55555555-5555-4555-8555-555555555555";
  let state = {};
  let closed = 0;
  let crashAfterAdminIntentSave = false;
  return {
    get state() { return structuredClone(state); },
    get closed() { return closed; },
    set crashAfterAdminIntentSave(value) { crashAfterAdminIntentSave = value; },
    factory: async () => ({
      record: { id, state: structuredClone(state) },
      save: async next => {
        state = structuredClone(next);
        if (crashAfterAdminIntentSave && next.status === "admin_intent") {
          crashAfterAdminIntentSave = false;
          throw Object.assign(new Error("lost journal response"), { code: "JOURNAL_RESPONSE_UNCERTAIN" });
        }
      },
      close: () => { closed += 1; },
    }),
  };
}

function lockHarness() {
  let owner = null;
  let acquires = 0;
  let releases = 0;
  let failRelease = false;
  let failAcquire = false;
  return {
    get owner() { return owner; },
    get acquires() { return acquires; },
    get releases() { return releases; },
    set failRelease(value) { failRelease = value; },
    set failAcquire(value) { failAcquire = value; },
    createOwner: () => "6666666666666666666666666666666666666666",
    status: () => owner,
    acquire: candidate => {
      if (owner !== null) throw Object.assign(new Error("BUSY"), { code: "BUSY" });
      owner = candidate;
      acquires += 1;
      if (failAcquire) {
        failAcquire = false;
        throw Object.assign(new Error("ACQUIRE_UNCERTAIN"), { code: "ACQUIRE_UNCERTAIN" });
      }
    },
    assertOwned: candidate => assert.equal(owner, candidate),
    release: candidate => {
      assert.equal(owner, candidate);
      releases += 1;
      if (failRelease) throw Object.assign(new Error("RELEASE_UNCERTAIN"), { code: "RELEASE_UNCERTAIN" });
      owner = null;
    },
  };
}

function liveProvider(...inventories) {
  let index = 0;
  return {
    capture: async () => inventories[Math.min(index++, inventories.length - 1)],
  };
}

async function protectedFixture({ versionId = VERSION, postAdmin, operation, lock, resume = false } = {}) {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const result = await runProtectedTelemetryRuntimeActivation({
    accountId: ACCOUNT,
    workerName: WORKER,
    repositoryRoot: "/private/tmp/synthetic-checkout",
    operationDirectory: "/private/tmp/synthetic-operation",
    request,
    session: adminSession(),
    resume,
    provider: liveProvider(inventory(versionId), inventory(versionId)),
    lockFactory: () => lock,
    operationFactory: operation.factory,
    postAdmin,
  });
  await captured.cleanup();
  return { request, result };
}

test("refuses a stale version receipt before the admin POST", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  let posts = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_LIVE_DEPLOYMENT_DRIFT" });
    assert.equal(posts, 0);
    assert.equal(lock.owner, null);
    assert.deepEqual(operation.state.result, { status: "refused" });
  } finally {
    await captured.cleanup();
  }
});

test("replays an admin intent under the existing lock after a lost response", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  let posts = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory(), inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; throw new Error("lost response"); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RESULT_UNCERTAIN" });
    assert.equal(operation.state.status, "admin_intent");
    const replay = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      provider: liveProvider(inventory(), inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    });
    assert.deepEqual(replay, resultFor(request));
    assert.equal(posts, 2);
    assert.equal(lock.acquires, 1);
    assert.equal(lock.owner, null);
  } finally {
    await captured.cleanup();
  }
});

test("reconciles post-POST deployment drift through an exact replay before releasing", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  const changedVersion = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let posts = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory(), inventory(changedVersion)),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_LIVE_DEPLOYMENT_DRIFT_AFTER_MUTATION" });
    assert.equal(operation.state.status, "admin_intent");
    assert.notEqual(lock.owner, null);

    const replay = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      provider: { capture: async () => assert.fail("completed replay must not require live capture") },
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    });
    assert.deepEqual(replay, resultFor(request));
    assert.equal(posts, 2);
    assert.equal(lock.owner, null);
    assert.equal(operation.state.status, "completed");
  } finally {
    await captured.cleanup();
  }
});

test("reconciles a no-request-reached intent after later deployment drift and releases safely", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  const changedVersion = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let posts = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; throw new Error("request never reached admin"); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RESULT_UNCERTAIN" });
    assert.equal(operation.state.status, "admin_intent");
    assert.notEqual(lock.owner, null);

    const reconciled = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      provider: liveProvider(inventory(changedVersion)),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; throw Object.assign(new Error("stale receipt"), {
        code: "TELEMETRY_RUNTIME_RECONCILIATION_LIVE_DEPLOYMENT_DRIFT",
      }); },
      reconcileOutcome: async ({ inventory: current }) => {
        assert.equal(current.version.id, changedVersion);
        return { kind: "refused", result: { status: "refused" } };
      },
    });
    assert.deepEqual(reconciled, { status: "refused" });
    assert.equal(posts, 2);
    assert.equal(lock.owner, null);
    assert.equal(operation.state.status, "completed");
  } finally {
    await captured.cleanup();
  }
});

test("read-only reconcile never POSTs an ambiguous started intent", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const operation = operationHarness();
  const lock = lockHarness();
  let posts = 0;
  let reconciliationReads = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; throw new Error("request never reached admin"); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RESULT_UNCERTAIN" });
    assert.equal(operation.state.status, "admin_intent");
    assert.equal(posts, 1);

    const activation = request.telemetryRuntimeActivation;
    const details = {
      schemaVersion: "telemetry-runtime-activation-v1",
      task: "telemetry_runtime_activation",
      idempotencyKey: activation.idempotencyKey,
      target: activation.target,
      expectedRevision: activation.expectedRevision,
      reconciliation: activation.reconciliation,
    };
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      reconcileOnly: true,
      environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => {
        posts += 1;
        assert.fail("read-only reconcile must never POST to the admin route");
      },
      fetchImpl: async (url, options) => {
        reconciliationReads += 1;
        assert.match(url, new RegExp(`/accounts/${ACCOUNT}/d1/database/${PRIMARY}/query$`));
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.match(body.sql, /telemetry_v12_runtime/u);
        assert.deepEqual(body.params, [activation.idempotencyKey]);
        return Response.json({
          success: true,
          result: [{
            success: true,
            results: [{
              audit_action: "run_maintenance",
              audit_details_json: JSON.stringify(details),
              audit_operation_id: activation.idempotencyKey,
              audit_outcome: "started",
              runtime_policy_revision: activation.expectedRevision,
              runtime_state: "staged",
            }],
          }],
        });
      },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RECONCILE_REQUIRED" });
    assert.equal(posts, 1);
    assert.equal(reconciliationReads, 1);
    assert.notEqual(lock.owner, null);
    assert.equal(operation.state.status, "admin_intent");
  } finally {
    await captured.cleanup();
  }
});

test("uses the fixed D1 audit/runtime read before releasing a durable failure", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  let posts = 0;
  let reconciliationReads = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; throw new Error("request never reached admin"); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RESULT_UNCERTAIN" });

    const activation = request.telemetryRuntimeActivation;
    const details = {
      schemaVersion: "telemetry-runtime-activation-v1",
      task: "telemetry_runtime_activation",
      idempotencyKey: activation.idempotencyKey,
      target: activation.target,
      expectedRevision: activation.expectedRevision,
      reconciliation: activation.reconciliation,
      code: "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE",
    };
    const resume = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
      provider: liveProvider(inventory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; throw Object.assign(new Error("stale receipt"), {
        code: "TELEMETRY_RUNTIME_RECONCILIATION_LIVE_DEPLOYMENT_DRIFT",
      }); },
      fetchImpl: async (url, options) => {
        reconciliationReads += 1;
        assert.match(url, new RegExp(`/accounts/${ACCOUNT}/d1/database/${PRIMARY}/query$`));
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.match(body.sql, /telemetry_v12_runtime/u);
        assert.deepEqual(body.params, [activation.idempotencyKey]);
        return Response.json({
          success: true,
          result: [{
            success: true,
            results: [{
              audit_action: "run_maintenance",
              audit_details_json: JSON.stringify(details),
              audit_operation_id: activation.idempotencyKey,
              audit_outcome: "failure",
              runtime_policy_revision: 1,
              runtime_state: "staged",
            }],
          }],
        });
      },
    });
    assert.deepEqual(resume, { status: "refused" });
    assert.equal(reconciliationReads, 1);
    assert.equal(posts, 2);
    assert.equal(lock.owner, null);
    assert.equal(operation.state.status, "completed");
    const replay = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      provider: { capture: async () => assert.fail("completed refusal must not capture live state") },
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => assert.fail("completed refusal must not POST"),
    });
    assert.deepEqual(replay, { status: "refused" });
  } finally {
    await captured.cleanup();
  }
});

test("resumes a pre-acquire journal crash and a lost acquire response", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  lock.failAcquire = true;
  let posts = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_UNAVAILABLE" });
    assert.equal(operation.state.status, "lock_intent");
    const result = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      provider: liveProvider(inventory(), inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    });
    assert.deepEqual(result, resultFor(request));
    assert.equal(posts, 1);
    assert.equal(lock.acquires, 1);
    assert.equal(lock.owner, null);
  } finally {
    await captured.cleanup();
  }
});

test("retains an admin intent when the intent-save response is lost", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  operation.crashAfterAdminIntentSave = true;
  const lock = lockHarness();
  let posts = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RESULT_UNCERTAIN" });
    assert.equal(operation.state.status, "admin_intent");
    const result = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      provider: liveProvider(inventory(), inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    });
    assert.deepEqual(result, resultFor(request));
    assert.equal(posts, 1);
    assert.equal(lock.owner, null);
  } finally {
    await captured.cleanup();
  }
});

test("finishes a saved release intent without posting again", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  lock.failRelease = true;
  let posts = 0;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory(), inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RESULT_UNCERTAIN" });
    assert.equal(operation.state.status, "release_intent");
    lock.failRelease = false;
    const replay = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      resume: true,
      provider: liveProvider(inventory(), inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => { posts += 1; return resultFor(request); },
    });
    assert.deepEqual(replay, resultFor(request));
    assert.equal(posts, 1);
    assert.equal(lock.owner, null);
    assert.equal(operation.state.status, "completed");
  } finally {
    await captured.cleanup();
  }
});

test("requires one owner Access authentication material", async () => {
  const captured = await runFixture();
  const operation = operationHarness();
  const lock = lockHarness();
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request: activationRequest(captured.proof),
      session: { ...adminSession(), accessJwt: null, cookie: "" },
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => assert.fail("invalid session must fail before POST"),
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ADMIN_SESSION_INVALID" });
  } finally {
    await captured.cleanup();
  }
});

test("posts the exact-origin admin request with the owner Access guard", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof);
  const operation = operationHarness();
  const lock = lockHarness();
  const calls = [];
  try {
    const result = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: adminSession(),
      provider: liveProvider(inventory(), inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({
          schemaVersion: "admin-action-v0.1",
          action: "run_maintenance",
          result: resultFor(request),
        });
      },
    });
    assert.deepEqual(result, resultFor(request));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEPLOYMENT_ENDPOINTS.admin.origin}/api/v1/admin/action`);
    assert.equal(calls[0].options.headers.origin, DEPLOYMENT_ENDPOINTS.admin.origin);
    assert.equal(calls[0].options.headers["x-usage-monitor-admin"], "1");
    assert.equal(calls[0].options.headers["x-usage-monitor-csrf"], "synthetic-csrf-token");
    assert.equal(calls[0].options.headers.cookie, "CF_Authorization=synthetic-owner-session; __Host-usage_monitor_session=synthetic-app-session");
    assert.equal(calls[0].options.headers["cf-access-jwt-assertion"], "synthetic-access-jwt");
    assert.deepEqual(JSON.parse(calls[0].options.body), request);
  } finally {
    await captured.cleanup();
  }
});

function browserHandoffResult(request) {
  const activation = request.telemetryRuntimeActivation;
  return {
    status: "action_required",
    transport: "same_origin_browser",
    origin: DEPLOYMENT_ENDPOINTS.admin.origin,
    path: "/api/v1/admin/action",
    method: "POST",
    operationId: activation.idempotencyKey,
    target: activation.target,
    expectedRevision: activation.expectedRevision,
    requestSha256: identityDigest(request),
    proofSha256: activation.reconciliation.proofSha256,
    attestationSha256: activation.reconciliation.deploymentAttestation.attestationSha256,
  };
}

function browserAuditDetails(request, code = null) {
  const activation = request.telemetryRuntimeActivation;
  return {
    schemaVersion: "telemetry-runtime-activation-v1",
    task: "telemetry_runtime_activation",
    idempotencyKey: activation.idempotencyKey,
    target: activation.target,
    expectedRevision: activation.expectedRevision,
    reconciliation: activation.reconciliation,
    ...(code === null ? {
      state: "active",
      fromRevision: activation.expectedRevision,
      toRevision: activation.expectedRevision + 1,
    } : {}),
    ...(code === null ? {} : { code }),
  };
}

async function armBrowserFixture({ requestSha256 = null } = {}) {
  const captured = await runFixture();
  const request = activationRequest(captured.proof, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  const operation = operationHarness();
  const lock = lockHarness();
  const result = await runProtectedTelemetryRuntimeActivation({
    accountId: ACCOUNT,
    workerName: WORKER,
    repositoryRoot: "/private/tmp/synthetic-checkout",
    operationDirectory: "/private/tmp/synthetic-operation",
    request,
    session: null,
    requestSha256: requestSha256 ?? undefined,
    transport: "browser",
    provider: liveProvider(inventory(), inventory()),
    lockFactory: () => lock,
    operationFactory: operation.factory,
    postAdmin: async () => assert.fail("browser arm must never POST"),
  });
  return { captured, request, operation, lock, result };
}

test("arms a content-free same-origin browser handoff and journals before action", async () => {
  const fixture = await armBrowserFixture();
  try {
    assert.deepEqual(fixture.result, browserHandoffResult(fixture.request));
    assert.equal(fixture.operation.state.status, "browser_action_required");
    assert.notEqual(fixture.lock.owner, null);
    const serialized = JSON.stringify({ result: fixture.result, state: fixture.operation.state });
    assert.doesNotMatch(serialized, /cookie|jwt|token|authorization/iu);
    assert.deepEqual(fixture.operation.state.browserHandoff, {
      schema: "telemetry-runtime-browser-handoff-v1",
      origin: DEPLOYMENT_ENDPOINTS.admin.origin,
      path: "/api/v1/admin/action",
      method: "POST",
      operationId: fixture.request.telemetryRuntimeActivation.idempotencyKey,
      target: "usage_v12",
      expectedRevision: 1,
      requestSha256: identityDigest(fixture.request),
      proofSha256: fixture.request.telemetryRuntimeActivation.reconciliation.proofSha256,
      attestationSha256: fixture.request.telemetryRuntimeActivation.reconciliation.deploymentAttestation.attestationSha256,
      sourceCommit: SOURCE,
      versionId: VERSION,
      configSha256: fixture.request.telemetryRuntimeActivation.reconciliation.configSha256,
    });
  } finally {
    await fixture.captured.cleanup();
  }
});

test("persists browser action intent to the owner operation journal", async () => {
  const captured = await runFixture();
  const root = await mkdtemp("/private/tmp/telemetry-browser-journal-");
  await chmod(root, 0o700);
  const operationDirectory = join(root, "activation");
  const request = activationRequest(captured.proof, "99999999-9999-4999-8999-999999999999");
  const lock = lockHarness();
  try {
    const result = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory,
      request,
      session: null,
      transport: "browser",
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: openOperation,
      postAdmin: async () => assert.fail("browser arm must never POST"),
    });
    const journal = await readOperation(operationDirectory);
    assert.equal(result.status, "action_required");
    assert.equal(journal.state.status, "browser_action_required");
    assert.equal(journal.state.browserHandoff.requestSha256, identityDigest(request));
    assert.notEqual(lock.owner, null);
  } finally {
    await captured.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("binds the browser handoff to the exact request-file bytes", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof, "ffffffff-ffff-4fff-8fff-ffffffffffff");
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  const requestSha256 = createHash("sha256").update(requestBytes).digest("hex");
  const operation = operationHarness();
  const lock = lockHarness();
  try {
    const result = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      requestSha256,
      session: null,
      transport: "browser",
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => assert.fail("browser arm must never POST"),
    });
    assert.equal(result.requestSha256, requestSha256);
    assert.equal(operation.state.browserHandoff.requestSha256, requestSha256);
  } finally {
    await captured.cleanup();
  }
});

test("requires a private session for the existing transport but not browser arm", async () => {
  const browser = await armBrowserFixture();
  try {
    assert.equal(browser.result.transport, "same_origin_browser");
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/other-synthetic-operation",
      request: activationRequest(browser.captured.proof),
      session: null,
      provider: liveProvider(inventory()),
      lockFactory: () => lockHarness(),
      operationFactory: operationHarness().factory,
      postAdmin: async () => assert.fail("missing session must fail before POST"),
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ADMIN_SESSION_INVALID" });
  } finally {
    await browser.captured.cleanup();
  }
});

test("resumes a browser arm without reading credentials or posting", async () => {
  const fixture = await armBrowserFixture();
  try {
    const resumed = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request: fixture.request,
      session: null,
      transport: "browser",
      resume: true,
      provider: liveProvider(inventory()),
      lockFactory: () => fixture.lock,
      operationFactory: fixture.operation.factory,
      postAdmin: async () => assert.fail("browser resume must never POST"),
    });
    assert.deepEqual(resumed, fixture.result);
    assert.notEqual(fixture.lock.owner, null);
    assert.equal(fixture.operation.state.status, "browser_action_required");
  } finally {
    await fixture.captured.cleanup();
  }
});

test("resumes a browser arm after an uncertain lock acquisition", async () => {
  const captured = await runFixture();
  const request = activationRequest(captured.proof, "abababab-abab-4aba-8aba-abababababab");
  const operation = operationHarness();
  const lock = lockHarness();
  lock.failAcquire = true;
  try {
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: null,
      transport: "browser",
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => assert.fail("browser arm must never POST"),
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_UNAVAILABLE" });
    assert.equal(operation.state.status, "lock_intent");
    const result = await runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request,
      session: null,
      transport: "browser",
      resume: true,
      provider: liveProvider(inventory()),
      lockFactory: () => lock,
      operationFactory: operation.factory,
      postAdmin: async () => assert.fail("browser arm must never POST"),
    });
    assert.deepEqual(result, browserHandoffResult(request));
    assert.equal(operation.state.status, "browser_action_required");
    assert.notEqual(lock.owner, null);
  } finally {
    await captured.cleanup();
  }
});

test("refuses source or config drift before arming a browser handoff", async () => {
  const captured = await runFixture();
  try {
    for (const changed of [
      inventory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      inventory(VERSION, "c".repeat(40)),
    ]) {
      const request = activationRequest(captured.proof);
      const operation = operationHarness();
      const lock = lockHarness();
      await assert.rejects(runProtectedTelemetryRuntimeActivation({
        accountId: ACCOUNT,
        workerName: WORKER,
        repositoryRoot: "/private/tmp/synthetic-checkout",
        operationDirectory: "/private/tmp/synthetic-operation",
        request,
        session: null,
        transport: "browser",
        provider: liveProvider(changed),
        lockFactory: () => lock,
        operationFactory: operation.factory,
        postAdmin: async () => assert.fail("drift must fail before browser handoff"),
      }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_LIVE_DEPLOYMENT_DRIFT" });
      assert.equal(lock.owner, null);
      assert.deepEqual(operation.state.result, { status: "refused" });
    }
  } finally {
    await captured.cleanup();
  }
});

for (const [outcome, rowState, rowRevision, expected] of [
  ["success", "active", 2, { kind: "success" }],
  ["failure", "staged", 1, { kind: "refused" }],
]) {
  test(`browser reconcile releases a durable ${outcome} outcome`, async () => {
    const fixture = await armBrowserFixture();
    try {
      const activation = fixture.request.telemetryRuntimeActivation;
      let posts = 0;
      const result = await runProtectedTelemetryRuntimeActivation({
        accountId: ACCOUNT,
        workerName: WORKER,
        repositoryRoot: "/private/tmp/synthetic-checkout",
        operationDirectory: "/private/tmp/synthetic-operation",
        request: fixture.request,
        session: null,
        resume: true,
        reconcileOnly: true,
        environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
        provider: liveProvider(inventory()),
        lockFactory: () => fixture.lock,
        operationFactory: fixture.operation.factory,
        postAdmin: async () => { posts += 1; assert.fail("browser reconcile must never POST"); },
        fetchImpl: async (url, options) => {
          assert.match(url, new RegExp(`/accounts/${ACCOUNT}/d1/database/${PRIMARY}/query$`));
          assert.equal(options.method, "POST");
          const body = JSON.parse(options.body);
          assert.deepEqual(body.params, [activation.idempotencyKey]);
          const details = browserAuditDetails(fixture.request, outcome === "failure"
            ? "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE" : null);
          return Response.json({ success: true, result: [{
            success: true,
            results: [{
              audit_action: "run_maintenance",
              audit_details_json: JSON.stringify(details),
              audit_operation_id: activation.idempotencyKey,
              audit_outcome: outcome,
              runtime_policy_revision: rowRevision,
              runtime_state: rowState,
            }],
          }] });
        },
      });
      assert.deepEqual(result, expected.kind === "success" ? resultFor(fixture.request) : { status: "refused" });
      assert.equal(posts, 0);
      assert.equal(fixture.lock.owner, null);
      assert.equal(fixture.operation.state.status, "completed");
    } finally {
      await fixture.captured.cleanup();
    }
  });
}

for (const [outcome, rowState, rowRevision] of [
  ["success", "active", 2],
  ["failure", "staged", 1],
]) {
  test(`browser reconcile retains the lock when deployment drifts during ${outcome} audit read`, async () => {
    const fixture = await armBrowserFixture();
    try {
      const activation = fixture.request.telemetryRuntimeActivation;
      let reads = 0;
      await assert.rejects(runProtectedTelemetryRuntimeActivation({
        accountId: ACCOUNT,
        workerName: WORKER,
        repositoryRoot: "/private/tmp/synthetic-checkout",
        operationDirectory: "/private/tmp/synthetic-operation",
        request: fixture.request,
        session: null,
        resume: true,
        reconcileOnly: true,
        environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
        provider: liveProvider(
          inventory(),
          inventory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        ),
        lockFactory: () => fixture.lock,
        operationFactory: fixture.operation.factory,
        postAdmin: async () => assert.fail("browser reconcile must never POST"),
        fetchImpl: async () => {
          reads += 1;
          return Response.json({ success: true, result: [{
            success: true,
            results: [{
              audit_action: "run_maintenance",
              audit_details_json: JSON.stringify(browserAuditDetails(
                fixture.request,
                outcome === "failure" ? "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE" : null,
              )),
              audit_operation_id: activation.idempotencyKey,
              audit_outcome: outcome,
              runtime_policy_revision: rowRevision,
              runtime_state: rowState,
            }],
          }] });
        },
      }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RECONCILE_REQUIRED" });
      assert.equal(reads, 1);
      assert.notEqual(fixture.lock.owner, null);
      assert.equal(fixture.operation.state.status, "browser_action_required");
    } finally {
      await fixture.captured.cleanup();
    }
  });
}

test("browser reconcile retains the lock when the post-read deployment capture fails", async () => {
  const fixture = await armBrowserFixture();
  try {
    const activation = fixture.request.telemetryRuntimeActivation;
    let captures = 0;
    let reads = 0;
    let posts = 0;
    await assert.rejects(runProtectedTelemetryRuntimeActivation({
      accountId: ACCOUNT,
      workerName: WORKER,
      repositoryRoot: "/private/tmp/synthetic-checkout",
      operationDirectory: "/private/tmp/synthetic-operation",
      request: fixture.request,
      session: null,
      resume: true,
      reconcileOnly: true,
      environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
      provider: {
        capture: async () => {
          captures += 1;
          if (captures === 1) return inventory();
          throw new Error("post-read deployment capture failed");
        },
      },
      lockFactory: () => fixture.lock,
      operationFactory: fixture.operation.factory,
      postAdmin: async () => {
        posts += 1;
        assert.fail("browser reconcile must never POST");
      },
      fetchImpl: async () => {
        reads += 1;
        return Response.json({ success: true, result: [{
          success: true,
          results: [{
            audit_action: "run_maintenance",
            audit_details_json: JSON.stringify(browserAuditDetails(fixture.request)),
            audit_operation_id: activation.idempotencyKey,
            audit_outcome: "success",
            runtime_policy_revision: 2,
            runtime_state: "active",
          }],
        }] });
      },
    }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RECONCILE_REQUIRED" });
    assert.equal(captures, 2);
    assert.equal(reads, 1);
    assert.equal(posts, 0);
    assert.notEqual(fixture.lock.owner, null);
    assert.equal(fixture.operation.state.status, "browser_action_required");
  } finally {
    await fixture.captured.cleanup();
  }
});

for (const [label, rows, provider] of [
  ["started", [{ audit_outcome: "started", runtime_policy_revision: 1, runtime_state: "staged" }], liveProvider(inventory())],
  ["missing", [], liveProvider(inventory())],
  ["drift", [{ audit_outcome: "success", runtime_policy_revision: 2, runtime_state: "active" }], liveProvider(inventory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))],
]) {
  test(`browser reconcile retains the lock for ${label} or ambiguous evidence`, async () => {
    const fixture = await armBrowserFixture();
    try {
      const activation = fixture.request.telemetryRuntimeActivation;
      let reads = 0;
      await assert.rejects(runProtectedTelemetryRuntimeActivation({
        accountId: ACCOUNT,
        workerName: WORKER,
        repositoryRoot: "/private/tmp/synthetic-checkout",
        operationDirectory: "/private/tmp/synthetic-operation",
        request: fixture.request,
        session: null,
        resume: true,
        reconcileOnly: true,
        environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
        provider,
        lockFactory: () => fixture.lock,
        operationFactory: fixture.operation.factory,
        postAdmin: async () => assert.fail("browser reconcile must never POST"),
        fetchImpl: async () => {
          reads += 1;
          const row = rows[0] === undefined ? [] : [{
            audit_action: "run_maintenance",
            audit_details_json: JSON.stringify(browserAuditDetails(fixture.request)),
            audit_operation_id: activation.idempotencyKey,
            ...rows[0],
          }];
          return Response.json({ success: true, result: [{ success: true, results: row }] });
        },
      }), { code: "TELEMETRY_RUNTIME_RECONCILIATION_ACTIVATION_RECONCILE_REQUIRED" });
      assert.equal(label === "drift" ? reads : reads, label === "drift" ? 0 : 1);
      assert.notEqual(fixture.lock.owner, null);
      assert.equal(fixture.operation.state.status, "browser_action_required");
    } finally {
      await fixture.captured.cleanup();
    }
  });
}
