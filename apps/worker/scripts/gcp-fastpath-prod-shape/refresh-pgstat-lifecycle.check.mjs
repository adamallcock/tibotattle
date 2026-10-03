import test from "node:test";
import assert from "node:assert/strict";
import { capturePgStat, refreshPgStatLifecycle, withoutStatementText } from "./refresh-pgstat-lifecycle.mjs";
const stats = (label) => ({ label, takenAt: "2026-10-03T00:00:00.000Z", extension: {},
  statements: [], database: {}, io: [], wal: {} });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
test("optional hook leaves the existing caller result and lifecycle unchanged", async () => {
  const result = { exitCode: 9 };
  assert.deepEqual(await refreshPgStatLifecycle({ run: async () => result }), { result, evidence: null });
});
test("before precedes spawn, during is drained, and after follows child exit", async () => {
  const order = [], pending = deferred(), entered = deferred(); let tick, cancelled = false;
  const measured = refreshPgStatLifecycle({ intervalMs: 10, schedule: (fn) => { tick = fn; return 1; },
    cancel: () => { cancelled = true; }, snapshot: async (label) => {
      order.push(label); if (label.startsWith("refresh-during")) { entered.resolve(); await pending.promise; order.push("during-drained"); }
      return stats(label);
    }, run: async () => { order.push("spawn"); tick(); await entered.promise; order.push("exit"); pending.resolve(); return 0; } });
  const { result, evidence } = await measured;
  assert.equal(result, 0); assert.equal(cancelled, true);
  assert.deepEqual(order, ["refresh-before", "spawn", "refresh-during-1", "exit", "during-drained", "refresh-after"]);
  assert.equal(evidence.scope, "refresh-child-window"); assert.equal(evidence.during.length, 1);
});
test("before failure prevents child spawn and child failure retains its identity after cleanup", async () => {
  const failure = new Error("synthetic failure"); let spawned = false;
  await assert.rejects(refreshPgStatLifecycle({ snapshot: async () => { throw failure; },
    run: async () => { spawned = true; } }), (error) => error === failure);
  assert.equal(spawned, false);
  let cancelled = false, calls = 0;
  await assert.rejects(refreshPgStatLifecycle({ schedule: () => 1, cancel: () => { cancelled = true; },
    snapshot: async (label) => { calls++; if (label === "refresh-after") throw new Error("secondary"); return stats(label); },
    run: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(cancelled, true); assert.equal(calls, 2);
});
test("periodic sampling is serial, bounded, and errors retain only a closed code", async () => {
  let tick, schedules = 0, count = 0;
  const { evidence } = await refreshPgStatLifecycle({ maxDuring: 1, schedule: (fn) => { schedules++; tick = fn; return 1; }, cancel: () => {},
    snapshot: async (label) => { if (label.startsWith("refresh-during")) { count++; throw Object.assign(new Error("synthetic private SQL"), { code: "untrusted private text" }); } return stats(label); },
    run: async () => { tick(); await new Promise((done) => setImmediate(done)); return 0; } });
  assert.equal(count, 1); assert.equal(schedules, 1); assert.equal(evidence.saturated, true);
  assert.deepEqual(evidence.errors, [{ label: "refresh-during-1", code: "MEAS_PGSTAT_SAMPLE_FAILED" }]);
  await assert.rejects(refreshPgStatLifecycle({ snapshot: async () => stats("before"), run: async () => 0, maxDuring: 2881 }), { code: "MEAS_PGSTAT_INTERVAL_INVALID" });
});
test("SQL text is absent from stored snapshots and deltas", async () => {
  const stripped = withoutStatementText({ statements: [{ text: "synthetic private query", queryid: "7", calls: 1 }] });
  assert.deepEqual(stripped.statements, [{ queryid: "7", calls: 1 }]);
  const { evidence } = await refreshPgStatLifecycle({ schedule: () => 1, cancel: () => {}, run: async () => 0,
    snapshot: async (label) => withoutStatementText({ ...stats(label), statements: [{ text: "synthetic private query", queryid: "7", role: "postgres", calls: label === "refresh-after" ? 2 : 1, total_exec_time: 4 }] }) });
  assert.equal(JSON.stringify(evidence).includes("synthetic private query"), false);
  assert.equal(Object.hasOwn(evidence.delta.statements[0], "text"), false);
  assert.equal(evidence.delta.statements[0].calls, 1);
});

test("a failed snapshot always releases its dedicated pool client", async () => {
  let released = false;
  const failure = Object.assign(new Error("synthetic unavailable database"), { code: "08006" });
  const pool = { connect: async () => ({ query: async () => { throw failure; }, release: () => { released = true; } }) };
  await assert.rejects(capturePgStat(pool, "refresh-before"), (error) => error === failure);
  assert.equal(released, true);
});
