/** Local, synthetic failure diagnostics: no database or provider calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAnalyticsRefreshStatementLedger, createSnapshotReadPool } from "./analytics-refresh-read.mjs";
import { analyticsRefreshFailureReceipt, runAnalyticsRefresh } from "./analytics-refresh.mjs";

const SNAPSHOT = "00000003-0000001B-1";
const failure = (code = "57014") => Object.assign(new Error("synthetic-private-error-sentinel"), {
  code, detail: "synthetic-private-detail-sentinel", readFailures: { injected: "synthetic-private-sentinel" },
});
const queryText = (family) => `/* analytics_v2:${family} */ SELECT $1`;
function poolFor(query) {
  return { async connect() { return { query, async release() {} }; } };
}

test("failed calls preserve exact error identity and successful ledger shape, with closed family and SQLSTATE", async () => {
  let clock = 0;
  const ledger = createAnalyticsRefreshStatementLedger({ clock: () => clock });
  const raw = failure();
  const reads = createSnapshotReadPool(poolFor(async (text) => {
    clock += 7;
    if (text.includes("SELECT")) throw raw;
    return { rows: [] };
  }), SNAPSHOT, { ledger });
  const client = await reads.connect();
  await assert.rejects(client.query(queryText("occurrences.v12_sources"), ["synthetic-bind-sentinel"]), error => error === raw);
  assert.deepEqual(ledger.summary(), { calls: 3, wallMs: 21,
    families: { "snapshot.control": { calls: 3, wallMs: 21, rows: 0, bytes: null } } });
  assert.deepEqual(ledger.failureSummary(), { model: "analytics-refresh-read-failures-v1", calls: 1, wallMs: 7, maxWallMs: 7,
    families: { "occurrences.v12_sources": { calls: 1, wallMs: 7, maxWallMs: 7, sqlStates: { "57014": 1 } } } });
  assert.deepEqual(Object.keys(raw).sort(), ["code", "detail", "readFailures"], "driver error gains no properties");
  await client.release();
});

test("concurrent failures retain every observation, unknown tags and states collapse, and figures stay bounded", async () => {
  const ledger = createAnalyticsRefreshStatementLedger({ clock: () => 1 });
  const reads = createSnapshotReadPool(poolFor(async (text) => {
    if (!text.includes("SELECT")) return { rows: [] };
    await new Promise(resolve => setImmediate(resolve));
    throw failure(text.includes("occurrences.scope") ? "55P03" : "OWNER");
  }), SNAPSHOT, { ledger });
  const clients = await Promise.all(Array.from({ length: 40 }, () => reads.connect()));
  const results = await Promise.allSettled(clients.map((client, i) => client.query(queryText(i < 2 ? "occurrences.scope" : `private_owner_${i}`), ["synthetic-bind-sentinel"])));
  assert.equal(results.filter(result => result.status === "rejected").length, 40);
  const summary = ledger.failureSummary();
  assert.equal(summary.calls, 40);
  assert.deepEqual(Object.keys(summary.families), ["occurrences.scope", "untagged"]);
  assert.equal(summary.families["occurrences.scope"].sqlStates["55P03"], 2);
  assert.equal(summary.families.untagged.sqlStates.other, 38);
  assert.doesNotMatch(JSON.stringify(summary), /private|OWNER|SELECT|sentinel|detail|stack|message/u);
  for (const wallMs of [NaN, Infinity, -1, Number.MAX_VALUE, Number.MAX_VALUE]) ledger.recordFailure("__proto__", wallMs, "__proto__");
  const bounded = ledger.failureSummary();
  assert.equal(bounded.wallMs, Number.MAX_SAFE_INTEGER);
  assert.equal(bounded.maxWallMs, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.keys(bounded.families).length, 2);
  for (const value of [bounded.calls, bounded.wallMs, bounded.maxWallMs]) assert.ok(Number.isSafeInteger(value) && value >= 0);
  await reads.close();
});

test("the diagnostic family mirror covers exactly the reader's closed registry", async () => {
  const owners = await readFile(new URL("../src/analytics-v2/owners.ts", import.meta.url), "utf8");
  const registry = owners.match(/ANALYTICS_V2_STATEMENT_FAMILIES = Object\.freeze\(\[([\s\S]*?)\] as const\)/u)[1];
  const families = [...registry.matchAll(/"([a-z_]+\.[a-z_]+)"/gu)].map(match => match[1]).sort();
  const ledger = createAnalyticsRefreshStatementLedger();
  for (const family of families) ledger.recordFailure(family, 1, "57014");
  assert.deepEqual(Object.keys(ledger.failureSummary().families), families);
  const source = await readFile(new URL("./analytics-refresh-read.mjs", import.meta.url), "utf8");
  const mirror = source.match(/const FAILURE_FAMILIES = new Set\(\[([\s\S]*?)\]\)/u)[1];
  assert.deepEqual([...mirror.matchAll(/"([a-z_]+\.[a-z_]+)"/gu)].map(match => match[1]).sort(), families);
});

test("clock, record, and driver SQLSTATE getter failures never replace a query outcome", async () => {
  const raw = failure();
  for (const mode of ["clock", "recordFailure", "sqlState", "record"]) {
    const boom = () => { throw new Error("synthetic-diagnostic-failure"); };
    const ledger = { clock: mode === "clock" ? boom : () => 0, record: mode === "record" ? boom : () => {},
      recordFailure: mode === "recordFailure" ? boom : () => {} };
    const error = mode === "sqlState" ? Object.defineProperty(failure(), "sqlState", { get: boom }) : raw;
    const reads = createSnapshotReadPool(poolFor(async text => {
      if (text.includes("SELECT") && mode !== "record") throw error;
      return { rows: [{ one: 1 }] };
    }), SNAPSHOT, { ledger });
    const client = await reads.connect();
    if (mode === "record") assert.deepEqual(await client.query("SELECT 1"), { rows: [{ one: 1 }] });
    else await assert.rejects(client.query("SELECT 1"), caught => caught === error);
    await reads.close();
  }
});

test("unavailable initial timing omits successful observations rather than fabricating zero elapsed", async () => {
  const ledger = createAnalyticsRefreshStatementLedger({ clock() { throw new Error("synthetic-clock-unavailable"); } });
  const reads = createSnapshotReadPool(poolFor(async () => ({ rows: [{ one: 1 }] })), SNAPSHOT, { ledger });
  const client = await reads.connect();
  assert.deepEqual(await client.query(queryText("occurrences.scope")), { rows: [{ one: 1 }] });
  assert.deepEqual(ledger.summary(), { calls: 0, wallMs: 0, families: {} });
  assert.equal(ledger.failureSummary(), null);
  await reads.close();
});

function runFixture(stage, { noReadFailure = false, success = false } = {}) {
  const raw = failure();
  let closed = false;
  const pool = poolFor(async text => {
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
    if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: SNAPSHOT }] };
    if (text.includes("to_regclass")) return { rows: [{ present: false }] };
    if (text.startsWith("/* analytics_v2:") && !success) throw raw;
    return { rows: [] };
  });
  const readCall = async readPool => {
    if (noReadFailure) throw raw;
    const client = await readPool.connect();
    try { await client.query(queryText("occurrences.scope"), ["synthetic-bind-sentinel"]); }
    catch {
      // A-1 recreates driver failures. Attribution must survive in the ledger.
      throw Object.assign(new Error("synthetic-wrapped-message"), { code: "ANALYTICS_V2_READ_STATEMENT_TIMEOUT", sqlState: "57014" });
    } finally { await client.release(); }
  };
  const store = {
    resolveAnalyticsV2Kernel: () => ({}), analyticsV2BundledKernelIdentity: () => ({}),
    analyticsV2BaselineRunStamp: () => ({ kernel: { kernelId: "synthetic-kernel" }, manifestVersion: "synthetic-manifest" }),
    readAnalyticsV2RefreshState: async () => ({ cursor: null }), proveAnalyticsV2PriceTransitions: async () => ({}),
    writeRunOutputs: async () => {
      assert.equal(success, true, "failed reads must never write");
      return { state: "complete", runId: "synthetic-run", owners: 0, ownerDays: 0, retainedOwners: 0, refusals: 0,
        publication: { published: 0, unchanged: [], blocked: 0, ownerSets: null }, cursor: null, timings: {} };
    },
  };
  const pipeline = {
    read: async ({ pool }) => stage === "read" ? readCall(pool) : { pool },
    compute: async (inputs, options) => {
      if (!success) return readCall(inputs.pool);
      const client = await inputs.pool.connect();
      try { await client.query(queryText("occurrences.scope")); }
      finally { await client.release(); }
      return { mode: options.mode, nowMs: options.nowMs, revisionSeed: options.revisionSeed };
    },
  };
  return { closed: () => closed, run: () => runAnalyticsRefresh({ argv: ["--mode=full", "--schema=synthetic"],
    env: { PG_TEST_HOST: "127.0.0.1", ANALYTICS_V2_MEMORY_BUDGET_MIB: "1024" },
    dependencies: { modules: { store, pipeline }, heapLimitBytes: 16 * 1024 ** 3, createPool: () => pool,
      closeResources: async () => { closed = true; } } }) };
}

for (const stage of ["read", "compute"]) test(`final failed receipt retains family evidence across wrapped ${stage} failure`, async () => {
  const fixture = runFixture(stage);
  await assert.rejects(fixture.run(), error => {
    const receipt = analyticsRefreshFailureReceipt(error);
    assert.deepEqual(Object.keys(receipt).sort(), ["code", "phase", "readFailures", "schemaVersion", "sqlState", "status"]);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.code, "ANALYTICS_V2_READ_STATEMENT_TIMEOUT");
    assert.equal(receipt.sqlState, "57014");
    assert.equal(receipt.phase, stage);
    assert.equal(receipt.readFailures.calls, 1);
    assert.equal(receipt.readFailures.families["occurrences.scope"].sqlStates["57014"], 1);
    assert.doesNotMatch(JSON.stringify(receipt), /sentinel|wrapped|SELECT|stack|message|detail|injected/u);
    return true;
  });
  assert.equal(fixture.closed(), true);
});

test("a failure without a failed snapshot call keeps the existing receipt keys", async () => {
  const fixture = runFixture("read", { noReadFailure: true });
  await assert.rejects(fixture.run(), error => {
    assert.deepEqual(analyticsRefreshFailureReceipt(error), { schemaVersion: "analytics-refresh-receipt-v1",
      status: "failed", code: "ANALYTICS_V2_REFRESH_FAILED", phase: "read", sqlState: "57014" });
    return true;
  });
  assert.equal(fixture.closed(), true);
  assert.equal(createAnalyticsRefreshStatementLedger().failureSummary(), null);
});


test("a successful refresh preserves the existing receipt and statement summary contracts", async () => {
  const fixture = runFixture("compute", { success: true });
  const receipt = await fixture.run();
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.state, "complete");
  assert.equal(Object.hasOwn(receipt, "readFailures"), false);
  assert.deepEqual(Object.keys(receipt.reads).sort(), ["model", "phaseWallMs", "server", "statements", "unattributedMs"]);
  assert.deepEqual(Object.keys(receipt.reads.statements).sort(), ["calls", "families", "wallMs"]);
  assert.equal(receipt.reads.statements.families["occurrences.scope"].calls, 1);
  assert.deepEqual(Object.keys(receipt.reads.statements.families["occurrences.scope"]).sort(), ["bytes", "calls", "rows", "wallMs"]);
  assert.equal(fixture.closed(), true);
});
