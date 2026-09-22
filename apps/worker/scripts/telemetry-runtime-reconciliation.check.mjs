import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { identityDigest } from "../../../scripts/lib/release-operation.mjs";
import {
  captureTelemetryRuntimeReconciliation,
  parseTelemetryRuntimeReconciliationArguments,
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

function inventory() {
  return {
    capturedAt: "2026-09-22T15:00:00.000Z",
    accountId: ACCOUNT,
    workerName: WORKER,
    version: { id: VERSION, resources: { script_runtime: runtime, bindings } },
    settings,
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
