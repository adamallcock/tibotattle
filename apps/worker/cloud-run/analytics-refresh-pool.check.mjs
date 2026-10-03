/**
 * The compute Worker pool (K-PAR, analytics-refresh-pool.mjs) without real
 * Workers: a scripted Worker stands in for dist/analytics-refresh-worker.mjs,
 * so admission, ordering, loads, progress and every failure path are checked
 * without a database or a build. The real Workers' byte-identical merge is
 * proven by postgres-test/analytics-v2-refresh.spec.mjs (W = 1, 2, 4) and the
 * Q-1 and dense rehearsals.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ANALYTICS_REFRESH_WORKER_BOUNDS,
  ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES,
  createAnalyticsRefreshOwnerPool,
} from "./analytics-refresh-pool.mjs";

const MIB = 1_048_576;

/** A Worker whose behaviour `script(worker, data)` drives; it records its options. */
function scriptedWorkers(script) {
  const spawned = [];
  const createWorker = (url, options) => {
    const worker = new EventEmitter();
    worker.options = options;
    worker.posted = [];
    worker.terminated = false;
    worker.postMessage = (message) => { worker.posted.push(message); worker.emit("_posted", message); };
    worker.terminate = async () => { worker.terminated = true; return 0; };
    spawned.push(worker);
    queueMicrotask(() => script(worker, options.workerData));
    return worker;
  };
  return { spawned, createWorker };
}

const task = (index, estimateMiB) => Object.freeze({ index, owner: { participantId: `p${index}`, ownerDigest: `${index}`.repeat(64).slice(0, 64) },
  evidence: [], estimateBytes: estimateMiB * MIB });
const io = (events = []) => ({
  load: async (span) => { events.push(["load", span.fromDay]); return new Map([[span.fromDay, { usage: [], quota: [], session: [] }]]); },
  progress: (event) => { events.push(["progress", event.kind]); },
  started: () => { events.push(["started"]); },
});
const result = (worker, index) => worker.emit("message", { type: "result", emissions: [{ kind: "refusal", index }],
  computation: { index }, timings: { prepare: 1 } });

test("bounds: 1..16 workers and a positive budget", () => {
  assert.deepEqual({ ...ANALYTICS_REFRESH_WORKER_BOUNDS }, { minimum: 1, maximum: 16 });
  assert.equal(ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES, 1_024 * MIB);
  for (const workers of [0, 17, 2.5, "4"]) {
    assert.throws(() => createAnalyticsRefreshOwnerPool({ workers, memoryBudgetBytes: MIB }),
      { code: "ANALYTICS_V2_REFRESH_WORKERS_INVALID" });
  }
  assert.throws(() => createAnalyticsRefreshOwnerPool({ workers: 2, memoryBudgetBytes: 0 }),
    { code: "ANALYTICS_V2_REFRESH_WORKERS_INVALID" });
});

test("longest estimate first, at most `workers` at once, limits within the budget plus one reserve", async () => {
  const order = [];
  const { spawned, createWorker } = scriptedWorkers((worker, data) => {
    order.push(data.task.index);
    // Finish on the next turn so admission can be observed.
    setTimeout(() => result(worker, data.task.index), 5);
  });
  // Budget 2,000 MiB: admission holds limits (estimate + 1,024) within 3,024 MiB.
  const pool = createAnalyticsRefreshOwnerPool({ workers: 2, memoryBudgetBytes: 2_000 * MIB, createWorker,
    workerUrl: new URL("file:///unused.mjs") });
  const tasks = [task(0, 100), task(1, 1_900), task(2, 300), task(3, 300)];
  let peak = 0;
  const watcher = setInterval(() => { peak = Math.max(peak, pool.running); }, 1);
  const results = await Promise.all(tasks.map((value) => pool.compute(value, { today: "2026-10-01" }, io())));
  clearInterval(watcher);
  assert.deepEqual(results.map((value) => value.computation.index), [0, 1, 2, 3], "results are per task, in submission order");
  // 1,900 first and alone (2,924 + 1,324 > 3,024); then 300 and 300
  // together (1,324 + 1,324 = 2,648); then 100.
  assert.deepEqual(order, [1, 2, 3, 0]);
  assert.ok(peak <= 2);
  assert.deepEqual(spawned.map((worker) => worker.options.resourceLimits.maxOldGenerationSizeMb),
    [1_900 + 1_024, 300 + 1_024, 300 + 1_024, 100 + 1_024]);
  assert.ok(spawned.every((worker) => worker.terminated), "every Worker is terminated once its owner is done");
  assert.deepEqual(spawned[0].options.env, {}, "a Worker inherits no environment");
  await pool.abort();
});

test("loads are served by the main thread one at a time; progress is forwarded", async () => {
  const events = [];
  const { createWorker } = scriptedWorkers((worker, data) => {
    worker.on("_posted", (message) => {
      if (message.type === "loaded") {
        worker.emit("message", { type: "progress", event: { kind: "scalar" } });
        result(worker, data.task.index);
      }
    });
    worker.emit("message", { type: "load", id: 0, span: { fromDay: `2026-01-0${data.task.index + 1}`, throughDay: "2026-01-09" } });
  });
  const pool = createAnalyticsRefreshOwnerPool({ workers: 2, memoryBudgetBytes: 1_000 * MIB, createWorker,
    workerUrl: new URL("file:///unused.mjs") });
  await Promise.all([pool.compute(task(0, 10), {}, io(events)), pool.compute(task(1, 10), {}, io(events))]);
  assert.deepEqual(events.filter(([kind]) => kind === "load").map(([, day]) => day).sort(), ["2026-01-01", "2026-01-02"]);
  assert.equal(events.filter(([kind]) => kind === "progress").length, 2);
  assert.equal(events.filter(([kind]) => kind === "started").length, 2);
});

test("a failure fails its owner with a closed code and aborts every other owner", async () => {
  for (const [label, act, code] of [
    ["failed", (worker) => worker.emit("message", { type: "failed", code: "ANALYTICS_V2_INPUT_INVALID" }),
      "ANALYTICS_V2_INPUT_INVALID"],
    ["unsafe code", (worker) => worker.emit("message", { type: "failed", code: "raw message with a value" }),
      "ANALYTICS_V2_REFRESH_WORKER_FAILED"],
    ["out of memory", (worker) => worker.emit("error", Object.assign(new Error("oom"), { code: "ERR_WORKER_OUT_OF_MEMORY" })),
      "ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY"],
    ["exit", (worker) => worker.emit("exit", 1), "ANALYTICS_V2_REFRESH_WORKER_EXITED"],
    ["protocol", (worker) => worker.emit("message", { type: "surprise" }), "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"],
  ]) {
    const { spawned, createWorker } = scriptedWorkers((worker, data) => {
      if (data.task.index === 0) setTimeout(() => act(worker), 2);
    });
    const pool = createAnalyticsRefreshOwnerPool({ workers: 1, memoryBudgetBytes: 100 * MIB, createWorker,
      workerUrl: new URL("file:///unused.mjs") });
    const first = pool.compute(task(0, 50), {}, io());
    const second = pool.compute(task(1, 10), {}, io());
    await assert.rejects(first, { code }, label);
    await assert.rejects(second, { code: "ANALYTICS_V2_REFRESH_WORKER_ABORTED" }, `${label}: queued owners are refused`);
    assert.ok(spawned.every((worker) => worker.terminated), label);
    await assert.rejects(pool.compute(task(2, 10), {}, io()), { code: "ANALYTICS_V2_REFRESH_WORKER_ABORTED" });
  }
});

test("a progress refusal (the time guard) and a load failure fail the owner with their own error", async () => {
  const deadline = Object.assign(new Error("ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED"),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED" });
  const { createWorker } = scriptedWorkers((worker) => {
    worker.emit("message", { type: "progress", event: { kind: "model" } });
  });
  const pool = createAnalyticsRefreshOwnerPool({ workers: 1, memoryBudgetBytes: 100 * MIB, createWorker,
    workerUrl: new URL("file:///unused.mjs") });
  await assert.rejects(pool.compute(task(0, 10), {}, { ...io(), progress: () => { throw deadline; } }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED" });

  const source = Object.assign(new Error("ANALYTICS_V2_SOURCE_LIMIT"), { code: "ANALYTICS_V2_SOURCE_LIMIT" });
  const loads = scriptedWorkers((worker) => {
    worker.emit("message", { type: "load", id: 0, span: { fromDay: "2026-01-01", throughDay: "2026-01-02" } });
  });
  const loadPool = createAnalyticsRefreshOwnerPool({ workers: 1, memoryBudgetBytes: 100 * MIB,
    createWorker: loads.createWorker, workerUrl: new URL("file:///unused.mjs") });
  await assert.rejects(loadPool.compute(task(0, 10), {}, { ...io(), load: async () => { throw source; } }),
    { code: "ANALYTICS_V2_SOURCE_LIMIT" });
});

test("a task over the budget is refused before any Worker starts", async () => {
  const { spawned, createWorker } = scriptedWorkers(() => {});
  const pool = createAnalyticsRefreshOwnerPool({ workers: 2, memoryBudgetBytes: 100 * MIB, createWorker,
    workerUrl: new URL("file:///unused.mjs") });
  await assert.rejects(pool.compute(task(0, 101), {}, io()), { code: "ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID" });
  assert.equal(spawned.length, 0);
  await pool.abort();
});
