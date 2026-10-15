/** Local, synthetic failure diagnostics: no database or provider calls. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { createAnalyticsRefreshStatementLedger, createSnapshotReadPool } from "./analytics-refresh-read.mjs";
import { analyticsRefreshFailureReceipt, runAnalyticsRefresh } from "./analytics-refresh.mjs";

const SNAPSHOT = "00000003-0000001B-1";
const failure = (code = "57014") => Object.assign(new Error("synthetic-private-error-sentinel"), {
  code, detail: "synthetic-private-detail-sentinel", readFailures: { injected: "synthetic-private-sentinel" },
});
const queryText = (family) => `/* analytics_v2:${family} */ SELECT $1`;
function poolFor(query, { maxActive = Number.POSITIVE_INFINITY, beforeRelease = null } = {}) {
  const pool = new EventEmitter();
  let active = 0;
  let ending = false;
  const pending = [];
  pool.clients = [];
  const checkout = () => {
    const client = new EventEmitter();
    client.connectionIndex = pool.clients.length;
    client.queries = [];
    client.query = (text, values) => { client.queries.push(text); return query(text, client, values); };
    client.end = (callback) => { client.ended = true; callback?.(); };
    client.release = async (discard = false) => {
      if (client.released === true) return;
      try { beforeRelease?.(client, discard); } finally {
        client.released = true;
        client.releaseDiscard = discard;
        pool.emit("release", undefined, client);
        active -= 1;
        const next = pending.shift();
        if (next !== undefined) {
          queueMicrotask(() => {
            if (ending) next.reject(new Error("pool ended"));
            else next.resolve(checkout());
          });
        }
      }
    };
    pool.clients.push(client);
    active += 1;
    pool.emit("acquire", client);
    return client;
  };
  pool.connect = async () => {
    if (ending) throw new Error("pool ended");
    if (active < maxActive) return checkout();
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  pool.end = async () => {
    ending = true;
    for (const item of pending.splice(0)) item.reject(new Error("pool ended"));
  };
  return pool;
}

function pgPoolFor(query, { max = 8 } = {}) {
  const clients = [];
  const releaseListenerCounts = [];
  const releaseClients = [];
  class SyntheticPgClient extends EventEmitter {
    constructor() {
      super();
      this._queryable = true;
      this._ending = false;
      this.queries = [];
      clients.push(this);
    }
    connect(callback) { queueMicrotask(() => callback()); }
    query(text, values) {
      this.queries.push(text);
      assert.equal(this.listenerCount("error"), 1, "checked-out client has exactly the refresh observer");
      return query(text, this, values);
    }
    end(callback) {
      this._queryable = false;
      this._ending = true;
      queueMicrotask(() => { this.removeAllListeners("error"); callback?.(); });
    }
  }
  const pool = new pg.Pool({ Client: SyntheticPgClient, max, idleTimeoutMillis: 0 });
  // Observe every release at the actual pg.Pool boundary. Wrapping
  // client.release only once misses later checkouts because pg-pool installs
  // a fresh release closure on each acquisition.
  pool.on("release", (_error, client) => {
    queueMicrotask(() => {
      releaseListenerCounts.push(client.listenerCount("error"));
      releaseClients.push(client);
    });
  });
  return { pool, clients, releaseListenerCounts, releaseClients };
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

function connectionFixture({ eventAt = null, workers = 1, failCompute = false, drainReader = false,
  failingAbort = false, syncFailingAbort = false, queuedDuringTeardown = false,
  poolWithoutEvents = false, poolWithoutClientEvents = false, realPgPool = false,
  closeFailureAfterWrite = false, closeFailureAfterFailure = false } = {}) {
  const events = [];
  let writes = 0;
  let reads = 0;
  let computes = 0;
  let closed = false;
  let writeResolved = false;
  let pendingConnection;
  let queuedClient;
  let abortCallsAtErrorBurst = null;
  const query = async (text, client) => {
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
    if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: SNAPSHOT }] };
    if (text.includes("SELECT to_regclass('pg_stat_statements')") && eventAt === "stats-reader") {
      client.kind = "stats-reader";
      if (client.connectionFailureSent !== true) {
        client.connectionFailureSent = true;
        queueMicrotask(() => client.emit("error", failure("08006")));
        await new Promise(resolve => setImmediate(resolve));
      }
      return { rows: [{ present: false }] };
    }
    if (text.startsWith("/* analytics_v2:") && eventAt === "snapshot-reader") {
      client.kind = "snapshot-reader";
      if (client.connectionFailureSent !== true) {
        client.connectionFailureSent = true;
        client.emit("error", failure("08006"));
      }
      return { rows: [] };
    }
    if (text === "COMMIT" && eventAt === "commit") {
      client.emit("error", failure("08006"));
      return { rows: [] };
    }
    return { rows: [] };
  };
  const realPool = realPgPool ? pgPoolFor(query, { max: queuedDuringTeardown ? 2 : 8 }) : null;
  const pool = poolWithoutEvents ? {
    connectCalls: 0,
    async connect() { this.connectCalls += 1; throw new Error("unexpected connect"); },
  } : poolWithoutClientEvents ? Object.assign(new EventEmitter(), {
    connectCalls: 0,
    async connect() {
      this.connectCalls += 1;
      const client = { async query() { return { rows: [{ acquired: true }] }; }, async release() {} };
      this.emit("acquire", client);
      return client;
    },
    async end() {},
  }) : realPool?.pool ?? poolFor(query, {
    maxActive: queuedDuringTeardown ? 2 : Number.POSITIVE_INFINITY,
    beforeRelease(client) {
      if (client.kind === "snapshot-held" && eventAt === "drain") {
        events.push("snapshot-release");
        client.emit("error", failure("08006"));
      }
      if (client.connectionIndex === 0 && eventAt === "release-after-write" && writeResolved) {
        events.push("primary-release-after-write");
        client.emit("error", failure("08006"));
      }
      if (client.kind === "snapshot-held" && drainReader) events.push("snapshot-release");
      if (client.kind === "queued") {
        events.push("queued-release");
        queuedClient = client;
      }
    },
  });
  const clients = realPool?.clients ?? pool.clients ?? [];
  const ownerPool = {
    abortCalls: 0,
    abortOperations: 0,
    abortStarted: false,
    abortPromise: null,
    abort() {
      this.abortCalls += 1;
      if (this.abortStarted) return this.abortPromise ?? Promise.resolve();
      this.abortStarted = true;
      this.abortOperations += 1;
      events.push("worker-drain-start");
      if (syncFailingAbort) throw new Error("synthetic-abort-sentinel");
      this.abortPromise = new Promise(resolve => setImmediate(resolve)).then(() => {
        events.push("worker-drained");
        if (failingAbort) throw new Error("synthetic-abort-sentinel");
      });
      return this.abortPromise;
    },
    stats: () => ({}),
  };
  const store = {
    resolveAnalyticsV2Kernel: () => ({}), analyticsV2BundledKernelIdentity: () => ({}),
    analyticsV2BaselineRunStamp: () => ({ kernel: { kernelId: "synthetic-kernel" }, manifestVersion: "synthetic-manifest" }),
    readAnalyticsV2RefreshState: async () => ({ cursor: null }), proveAnalyticsV2PriceTransitions: async () => ({}),
    writeRunOutputs: async () => {
      writes += 1;
      writeResolved = true;
      return { state: "complete", runId: "synthetic-run", owners: 0, ownerDays: 0, retainedOwners: 0, refusals: 0,
        publication: { published: 0, unchanged: [], blocked: 0, ownerSets: null }, cursor: null, timings: {} };
    },
  };
  const pipeline = {
    read: async ({ pool: readPool }) => {
      reads += 1;
      if (eventAt === "snapshot-reader" || eventAt === "drain" || drainReader || queuedDuringTeardown) {
        const wrapper = await readPool.connect();
        const client = clients.at(-1);
        if (client !== undefined) client.kind = "snapshot-held";
        if (eventAt === "snapshot-reader") {
          await wrapper.query(queryText("occurrences.scope"), ["synthetic-bind-sentinel"]);
          await wrapper.release();
        }
        // For drain and queued-acquisition cases, leave this checked out. The
        // main entry must abort compute before close() releases this reader.
        return { pool: readPool, heldReader: wrapper };
      }
      return { pool: readPool };
    },
    compute: async (inputs, options) => {
      computes += 1;
      if (queuedDuringTeardown) {
        // The main connection is still checked out and the snapshot reader
        // occupies the pool's second slot, so this acquisition queues.
        pendingConnection = pool.connect().then(client => {
          client.kind = "queued";
          queuedClient = client;
          events.push("queued-acquired");
          return client;
        });
        pendingConnection.catch(() => {});
      }
      if (eventAt === "compute" || eventAt === "repeat") {
        const primary = clients[0];
        if (eventAt === "compute") queueMicrotask(() => primary.emit("error", failure("08006")));
        else {
          primary.emit("error", failure("08006"));
          primary.emit("error", failure("08002"));
          primary.emit("error", failure("57P01"));
          abortCallsAtErrorBurst = ownerPool.abortCalls;
        }
      }
      if (queuedDuringTeardown) clients[0].emit("error", failure("08006"));
      if (failCompute) throw failure("57014");
      await new Promise(resolve => setImmediate(resolve));
      return { mode: options.mode, nowMs: options.nowMs, revisionSeed: options.revisionSeed };
    },
  };
  const dependencies = {
    modules: { store, pipeline }, heapLimitBytes: workers > 1 ? 8 * 1024 ** 3 : 16 * 1024 ** 3,
    createPool: () => pool,
    ...(workers > 1 ? { createOwnerPool: () => ownerPool } : {}),
    closeResources: async () => {
      events.push("resources-close");
      if (queuedDuringTeardown && pendingConnection !== undefined) {
        const client = await pendingConnection;
        await client.release();
        if (realPool !== null) events.push("queued-release");
      }
      await pool.end?.();
      closed = true;
      if ((closeFailureAfterWrite && writeResolved) || (closeFailureAfterFailure && !writeResolved)) {
        throw new Error("synthetic-close-sentinel");
      }
    },
  };
  return {
    pool, ownerPool, events,
    realPool,
    abortCallsAtErrorBurst: () => abortCallsAtErrorBurst,
    counts: () => ({ writes, reads, computes }),
    closed: () => closed,
    queuedClient: () => queuedClient,
    run: () => runAnalyticsRefresh({ argv: ["--mode=full", "--schema=synthetic", `--workers=${workers}`],
      env: { PG_TEST_HOST: "127.0.0.1", ANALYTICS_V2_MEMORY_BUDGET_MIB: "1024" }, dependencies }),
  };
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

async function assertConnectionLost(run, expectedPhase) {
  await assert.rejects(run(), error => {
    const receipt = analyticsRefreshFailureReceipt(error);
    assert.deepEqual(receipt, { schemaVersion: "analytics-refresh-receipt-v1", status: "failed",
      code: "ANALYTICS_V2_REFRESH_CONNECTION_LOST", phase: expectedPhase });
    assert.doesNotMatch(JSON.stringify(receipt), /sentinel|08006|08002|57P01|detail|message|stack/u);
    return true;
  });
}

test("an asynchronous checked-out primary error during compute produces a closed failure and no write", async () => {
  const fixture = connectionFixture({ eventAt: "compute", workers: 2 });
  await assertConnectionLost(fixture.run, "compute");
  assert.deepEqual(fixture.counts(), { writes: 0, reads: 1, computes: 1 });
  assert.equal(fixture.pool.clients[0].releaseDiscard, true);
  assert.equal(fixture.closed(), true);
});

test("snapshot-reader and server-stats client errors are observed across pool borrows", async t => {
  await t.test("snapshot reader", async () => {
    const fixture = connectionFixture({ eventAt: "snapshot-reader" });
    await assertConnectionLost(fixture.run, "read");
    assert.deepEqual(fixture.counts(), { writes: 0, reads: 1, computes: 0 });
  });
  await t.test("server statistics reader", async () => {
    const fixture = connectionFixture({ eventAt: "stats-reader" });
    await assertConnectionLost(fixture.run, "read");
    assert.deepEqual(fixture.counts(), { writes: 0, reads: 0, computes: 0 });
  });
});

test("a connection lost while draining snapshot readers stops before COMMIT", async () => {
  const fixture = connectionFixture({ eventAt: "drain", workers: 2 });
  await assertConnectionLost(fixture.run, "compute");
  assert.deepEqual(fixture.counts(), { writes: 0, reads: 1, computes: 1 });
  assert.equal(fixture.pool.clients[0].queries.includes("COMMIT"), false);
  assert.ok(fixture.events.indexOf("worker-drained") < fixture.events.indexOf("snapshot-release"));
});

test("a connection lost after COMMIT but before write is refused", async () => {
  const fixture = connectionFixture({ eventAt: "commit" });
  await assertConnectionLost(fixture.run, "compute");
  assert.equal(fixture.pool.clients[0].queries.includes("COMMIT"), true);
  assert.equal(fixture.counts().writes, 0);
});

test("repeated client errors keep the first closed phase, abort workers once, and do not leak rejections", async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const fixture = connectionFixture({ eventAt: "repeat", workers: 2, failingAbort: true });
  try {
    await assertConnectionLost(fixture.run, "compute");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.ownerPool.abortOperations, 1);
    assert.equal(fixture.ownerPool.abortCalls, 3, "cleanup joins the memoized abort during inner and outer teardown");
    assert.equal(fixture.abortCallsAtErrorBurst(), 1, "repeated event callbacks join one active abort");
    assert.ok(fixture.events.includes("worker-drained"));
    assert.deepEqual(unhandled, []);
    assert.equal(fixture.counts().writes, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a synchronous worker abort throw is contained without replacing connection-loss evidence", async () => {
  const fixture = connectionFixture({ eventAt: "compute", workers: 2, syncFailingAbort: true });
  await assertConnectionLost(fixture.run, "compute");
  assert.equal(fixture.ownerPool.abortOperations, 1);
  assert.equal(fixture.counts().writes, 0);
});

test("worker drain completes before leaked snapshot readers are released", async () => {
  const fixture = connectionFixture({ workers: 2, failCompute: true, drainReader: true });
  await assert.rejects(fixture.run(), error => analyticsRefreshFailureReceipt(error).phase === "compute");
  assert.ok(fixture.events.indexOf("worker-drained") < fixture.events.indexOf("snapshot-release"));
  assert.equal(fixture.closed(), true);
});

test("a queued acquisition is drained during teardown without leaking its client observer", { timeout: 2000 }, async () => {
  const fixture = connectionFixture({ queuedDuringTeardown: true, realPgPool: true });
  await assertConnectionLost(fixture.run, "compute");
  assert.ok(fixture.events.includes("queued-acquired"));
  assert.ok(fixture.events.includes("queued-release"));
  assert.equal(fixture.queuedClient().listenerCount("error"), 0);
  assert.equal(fixture.closed(), true);
});

test("a release-time client error after the durable write preserves the successful receipt", async () => {
  const fixture = connectionFixture({ eventAt: "release-after-write" });
  const receipt = await fixture.run();
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.state, "complete");
  assert.equal(fixture.counts().writes, 1);
  assert.equal(fixture.closed(), true);
});

test("a pipeline failure remains primary when a reader emits Client error during cleanup", async () => {
  const fixture = connectionFixture({ eventAt: "drain", workers: 2, failCompute: true });
  await assert.rejects(fixture.run(), error => {
    const receipt = analyticsRefreshFailureReceipt(error);
    assert.equal(receipt.code, "ANALYTICS_V2_REFRESH_FAILED");
    assert.equal(receipt.phase, "compute");
    assert.equal(receipt.sqlState, "57014");
    assert.doesNotMatch(JSON.stringify(receipt), /sentinel|08006|detail|message|stack/u);
    return true;
  });
  assert.equal(fixture.counts().writes, 0);
});

test("a computation failure remains primary when resource cleanup also fails", async () => {
  const fixture = connectionFixture({ failCompute: true, closeFailureAfterFailure: true });
  await assert.rejects(fixture.run(), error => {
    const receipt = analyticsRefreshFailureReceipt(error);
    assert.equal(receipt.code, "ANALYTICS_V2_REFRESH_FAILED");
    assert.equal(receipt.phase, "compute");
    assert.equal(receipt.sqlState, "57014");
    assert.doesNotMatch(JSON.stringify(receipt), /sentinel|CLOSE_FAILED|detail|message|stack/u);
    return true;
  });
  assert.equal(fixture.counts().writes, 0);
});

test("a resource-close failure after a confirmed write is reported without reversing success", async () => {
  const fixture = connectionFixture({ closeFailureAfterWrite: true });
  const receipt = await fixture.run();
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.state, "complete");
  assert.deepEqual(receipt.cleanup, { code: "ANALYTICS_V2_REFRESH_CLOSE_FAILED" });
  assert.doesNotMatch(JSON.stringify(receipt), /sentinel|detail|message|stack/u);
  assert.equal(fixture.counts().writes, 1);
});

test("the real pg.Pool acquire/release ordering brackets the synthetic client observer", async () => {
  const fixture = connectionFixture({ realPgPool: true });
  const receipt = await fixture.run();
  assert.equal(receipt.status, "ok");
  assert.ok(fixture.realPool.clients.length >= 2, "primary and server-stat clients used the real pool");
  assert.ok(fixture.realPool.releaseListenerCounts.length >= 2);
  assert.deepEqual(new Set(fixture.realPool.releaseListenerCounts), new Set([1]),
    "after pool release the pg idle listener remains and the run observer is detached");
  assert.ok(new Set(fixture.realPool.releaseClients).size < fixture.realPool.releaseClients.length,
    "the real pool reused a Client across acquisitions");
  assert.ok(fixture.realPool.clients.every(client => client.listenerCount("error") === 0),
    "all synthetic Client error listeners are gone after pool shutdown");
  assert.equal(fixture.pool.listenerCount("acquire"), 0);
  assert.equal(fixture.pool.listenerCount("release"), 1, "only the synthetic release recorder remains");
  assert.equal(fixture.pool.listenerCount("remove"), 0);
});

test("a pool without acquire/release event support fails closed before connecting", async () => {
  const fixture = connectionFixture({ poolWithoutEvents: true });
  await assert.rejects(fixture.run(), error => {
    assert.deepEqual(analyticsRefreshFailureReceipt(error), { schemaVersion: "analytics-refresh-receipt-v1",
      status: "failed", code: "ANALYTICS_V2_REFRESH_POOL_INVALID", phase: "connection" });
    return true;
  });
  assert.equal(fixture.pool.connectCalls, 0);
  assert.equal(fixture.closed(), true);
});

test("a pool-acquired client without EventEmitter methods fails with closed connection-loss evidence", async () => {
  const fixture = connectionFixture({ poolWithoutClientEvents: true });
  await assertConnectionLost(fixture.run, "connection");
  assert.equal(fixture.pool.connectCalls, 1);
  assert.equal(fixture.counts().writes, 0);
});

test("a successful refresh preserves the existing receipt and statement summary contracts", async () => {
  const fixture = runFixture("compute", { success: true });
  const receipt = await fixture.run();
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.state, "complete");
  assert.equal(Object.hasOwn(receipt, "readFailures"), false);
  assert.equal(Object.hasOwn(receipt, "cleanup"), false);
  assert.deepEqual(Object.keys(receipt.reads).sort(), ["model", "phaseWallMs", "server", "statements", "unattributedMs"]);
  assert.deepEqual(Object.keys(receipt.reads.statements).sort(), ["calls", "families", "wallMs"]);
  assert.equal(receipt.reads.statements.families["occurrences.scope"].calls, 1);
  assert.deepEqual(Object.keys(receipt.reads.statements.families["occurrences.scope"]).sort(), ["bytes", "calls", "rows", "wallMs"]);
  assert.equal(fixture.closed(), true);
});
