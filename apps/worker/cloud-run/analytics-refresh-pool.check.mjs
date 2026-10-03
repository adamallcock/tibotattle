/**
 * The compute Worker pool (K-PAR, K-PAR-MEM; analytics-refresh-pool.mjs)
 * without real Workers: a scripted Worker stands in for
 * dist/analytics-refresh-worker.mjs, so admission against the pool, the heap
 * limits, ordering, streamed and concurrent loads, the alone retry and every
 * failure path are checked without a database or a build. The real Workers'
 * byte-identical merge is proven by postgres-test/analytics-v2-refresh.spec.mjs
 * (W = 1, 2, 4) and the Q-1 and production-shaped rehearsals.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ANALYTICS_REFRESH_LOAD_CONCURRENCY_BOUNDS,
  ANALYTICS_REFRESH_WORKER_BOUNDS,
  ANALYTICS_REFRESH_WORKER_HEAP_MODEL,
  analyticsRefreshWorkerHeapLimitBytes,
  analyticsRefreshWorkerPoolMinimumBytes,
  createAnalyticsRefreshOwnerPool,
} from "./analytics-refresh-pool.mjs";

const MIB = 1_048_576;
const MODEL = ANALYTICS_REFRESH_WORKER_HEAP_MODEL;
const limitMiB = (estimateMiB) => Math.ceil(estimateMiB * MODEL.heapFactor + MODEL.heapReserveBytes / MIB);
const chargeMiB = (estimateMiB) => limitMiB(estimateMiB) + MODEL.overheadBytes / MIB;

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
/** An io whose load streams two parts (usage, then quota) per call. */
const io = (events = []) => ({
  load: async (span, onPart) => {
    events.push(["load", span.fromDay]);
    await onPart("usage", new Map([[span.fromDay, [{ id: 1 }]]]));
    await onPart("quota", new Map([[span.fromDay, [{ id: 2 }]]]));
    return null;
  },
  progress: (event) => { events.push(["progress", event.kind]); },
  started: () => { events.push(["started"]); },
});
const result = (worker, index, gcCallbackHeapPeakBytes = null) => worker.emit("message", { type: "result",
  emissions: [{ kind: "refusal", index }], computation: { index }, timings: { prepare: 1 }, gcCallbackHeapPeakBytes });
const options = (extra) => ({ workerUrl: new URL("file:///unused.mjs"), ...extra });

test("bounds, the heap model and its limits", () => {
  assert.deepEqual({ ...ANALYTICS_REFRESH_WORKER_BOUNDS }, { minimum: 1, maximum: 16 });
  assert.deepEqual({ ...ANALYTICS_REFRESH_LOAD_CONCURRENCY_BOUNDS }, { minimum: 1, maximum: 8 });
  assert.equal(MODEL.version, "analytics-refresh-worker-heap-v2");
  // The limit is the modelled heap in whole MiB, at most the pool less one overhead.
  const pool = 12_288 * MIB;
  assert.equal(analyticsRefreshWorkerHeapLimitBytes(5_153 * MIB, pool), limitMiB(5_153) * MIB);
  assert.equal(analyticsRefreshWorkerHeapLimitBytes(30_000 * MIB, pool), pool - MODEL.overheadBytes);
  assert.equal(analyticsRefreshWorkerHeapLimitBytes(1, pool) % MIB, 0);
  // The minimum pool's whole-pool limit holds the budget's largest owner's estimate.
  assert.equal(analyticsRefreshWorkerPoolMinimumBytes(10_752 * MIB), 10_752 * MIB + MODEL.overheadBytes);
  assert.ok(analyticsRefreshWorkerHeapLimitBytes(10_752 * MIB, analyticsRefreshWorkerPoolMinimumBytes(10_752 * MIB))
    >= 10_752 * MIB);
  for (const bad of [{ workers: 0 }, { workers: 17 }, { workers: 2.5 }, { workers: "4" },
    { memoryBudgetBytes: 0 }, { poolBytes: 1 }, { poolBytes: undefined }, { loadConcurrency: 0 },
    { loadConcurrency: 9 }]) {
    assert.throws(() => createAnalyticsRefreshOwnerPool({ workers: 2, memoryBudgetBytes: MIB, poolBytes: 8_192 * MIB,
      ...bad }), { code: "ANALYTICS_V2_REFRESH_WORKERS_INVALID" }, JSON.stringify(bad));
  }
});

test("largest estimate first, at most `workers` at once, charges within the pool, each Worker at its limit", async () => {
  const order = [];
  const { spawned, createWorker } = scriptedWorkers((worker, data) => {
    order.push(data.task.index);
    setTimeout(() => result(worker, data.task.index, 100 * MIB), 5);
  });
  // A pool that holds 1,900 and 300 together but not 1,900, 300 and 300.
  const poolMiB = chargeMiB(1_900) + chargeMiB(300) + 10;
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 3, memoryBudgetBytes: 2_000 * MIB,
    poolBytes: poolMiB * MIB, createWorker }));
  const tasks = [task(0, 100), task(1, 1_900), task(2, 300), task(3, 300)];
  let peak = 0;
  const watcher = setInterval(() => { peak = Math.max(peak, pool.running); }, 1);
  const results = await Promise.all(tasks.map((value) => pool.compute(value, { today: "2026-10-01" }, io())));
  clearInterval(watcher);
  assert.deepEqual(results.map((value) => value.computation.index), [0, 1, 2, 3], "results are per task, in submission order");
  // 1,900 and the first 300 together; the second 300 waits (it does not fit), and 100 waits behind it.
  assert.deepEqual(order, [1, 2, 3, 0]);
  assert.ok(peak <= 3);
  assert.deepEqual(spawned.map((worker) => worker.options.resourceLimits.maxOldGenerationSizeMb),
    [limitMiB(1_900), limitMiB(300), limitMiB(300), limitMiB(100)]);
  assert.ok(spawned.every((worker) => worker.options.resourceLimits.maxYoungGenerationSizeMb
    === MODEL.youngGenerationBytes / MIB), "every Worker gets the young-generation cap");
  assert.ok(MODEL.youngGenerationBytes <= MODEL.overheadBytes, "the young generation is inside the charged overhead");
  const stats = pool.stats();
  assert.ok(stats.peakChargedBytes <= poolMiB * MIB);
  assert.equal(stats.peakChargedBytes, (chargeMiB(1_900) + chargeMiB(300)) * MIB);
  assert.equal(stats.started, 4);
  assert.equal(stats.retriedAlone, 0);
  assert.equal(stats.largestGcCallbackHeapBytes, 100 * MIB);
  assert.ok(spawned.every((worker) => worker.terminated), "every Worker is terminated once its owner is done");
  assert.deepEqual(spawned[0].options.env, {}, "a Worker inherits no environment");
  await pool.abort();
});

test("loads are streamed as parts and run at most loadConcurrency at once; progress is forwarded", async () => {
  const events = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const slowIo = () => ({
    ...io(events),
    load: async (span, onPart) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await onPart("usage", new Map([[span.fromDay, [{ id: 1 }]]]));
      await onPart("session", new Map([[span.fromDay, [{ id: 3 }]]]));
      inFlight -= 1;
      return null;
    },
  });
  const { spawned, createWorker } = scriptedWorkers((worker, data) => {
    worker.on("_posted", (message) => {
      if (message.type === "loaded") {
        worker.emit("message", { type: "progress", event: { kind: "scalar" } });
        result(worker, data.task.index);
      }
    });
    worker.emit("message", { type: "load", id: 7, span: { fromDay: `2026-01-0${data.task.index + 1}`, throughDay: "2026-01-09" } });
  });
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 4, memoryBudgetBytes: 1_000 * MIB,
    poolBytes: 16_384 * MIB, loadConcurrency: 2, createWorker }));
  await Promise.all([0, 1, 2, 3].map((index) => pool.compute(task(index, 10), {}, slowIo())));
  assert.equal(peakInFlight, 2, "two loads at once, never more");
  assert.equal(pool.stats().peakLoads, 2);
  assert.equal(pool.stats().largestGcCallbackHeapBytes, null, "no GC callback sample stays unknown");
  assert.equal(pool.stats().largestGcCallbackHeapShareOfLimit, null);
  for (const worker of spawned) {
    // Each read call's days arrive as a part, in read order, then the load completes.
    assert.deepEqual(worker.posted.map((message) => [message.type, message.id, message.stream ?? null]),
      [["part", 7, "usage"], ["part", 7, "session"], ["loaded", 7, null]]);
    assert.ok(worker.posted[0].days instanceof Map);
  }
  assert.equal(events.filter(([kind]) => kind === "progress").length, 4);
  assert.equal(events.filter(([kind]) => kind === "started").length, 4);
});

test("an owner that outgrows its limit is retried once, alone, with the whole pool; then the run fails", async () => {
  const outOfMemory = (worker) => worker.emit("error", Object.assign(new Error("oom"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
  const poolBytes = 8_192 * MIB;
  // Owner 0 fails at its modelled limit and succeeds alone; owner 1 finishes first, then 0 runs alone.
  {
    const attempts = [];
    const runningAtSpawn = [];
    let pool;
    const { spawned, createWorker } = scriptedWorkers((worker, data) => {
      attempts.push([data.task.index, worker.options.resourceLimits.maxOldGenerationSizeMb]);
      runningAtSpawn.push(pool.running);
      if (data.task.index === 0 && attempts.filter(([index]) => index === 0).length === 1) {
        setTimeout(() => outOfMemory(worker), 2);
      } else {
        setTimeout(() => result(worker, data.task.index), 10);
      }
    });
    pool = createAnalyticsRefreshOwnerPool(options({ workers: 2, memoryBudgetBytes: 4_000 * MIB, poolBytes,
      createWorker }));
    const results = await Promise.all([pool.compute(task(0, 2_000), {}, io()), pool.compute(task(1, 1_000), {}, io())]);
    assert.deepEqual(results.map((value) => value.computation.index), [0, 1]);
    const aloneMiB = (poolBytes - MODEL.overheadBytes) / MIB;
    assert.deepEqual(attempts, [[0, limitMiB(2_000)], [1, limitMiB(1_000)], [0, aloneMiB]]);
    assert.equal(runningAtSpawn.at(-1), 1, "the retried owner runs alone");
    assert.equal(pool.stats().retriedAlone, 1);
    assert.equal(pool.stats().started, 3);
    assert.ok(spawned[0].terminated);
  }
  // Out of memory again, alone: the run fails with a closed code and the queue is refused.
  {
    const { createWorker } = scriptedWorkers((worker, data) => {
      if (data.task.index === 0) setTimeout(() => outOfMemory(worker), 2);
    });
    const pool = createAnalyticsRefreshOwnerPool(options({ workers: 1, memoryBudgetBytes: 4_000 * MIB, poolBytes,
      createWorker }));
    const first = pool.compute(task(0, 2_000), {}, io());
    const second = pool.compute(task(1, 10), {}, io());
    await assert.rejects(first, { code: "ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY" });
    await assert.rejects(second, { code: "ANALYTICS_V2_REFRESH_WORKER_ABORTED" });
    assert.equal(pool.stats().retriedAlone, 1);
  }
  // An owner already at the whole pool's limit is not retried.
  {
    const { createWorker } = scriptedWorkers((worker) => setTimeout(() => outOfMemory(worker), 2));
    const pool = createAnalyticsRefreshOwnerPool(options({ workers: 2, memoryBudgetBytes: 30_000 * MIB, poolBytes,
      createWorker }));
    await assert.rejects(pool.compute(task(0, 20_000), {}, io()), { code: "ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY" });
    assert.equal(pool.stats().retriedAlone, 0);
  }
});

test("a retried owner's earlier load stops delivering: its parts never reach a Worker", async () => {
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let attempts = 0;
  let stoppedEarly = false;
  const { spawned, createWorker } = scriptedWorkers((worker, data) => {
    attempts += 1;
    if (attempts === 1) {
      worker.emit("message", { type: "load", id: 0, span: { fromDay: "2026-01-01", throughDay: "2026-01-02" } });
      setTimeout(() => worker.emit("error", Object.assign(new Error("oom"), { code: "ERR_WORKER_OUT_OF_MEMORY" })), 2);
    } else {
      setTimeout(() => result(worker, data.task.index), 2);
    }
  });
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 1, memoryBudgetBytes: 4_000 * MIB,
    poolBytes: 8_192 * MIB, createWorker }));
  const done = pool.compute(task(0, 1_000), {}, {
    ...io(),
    load: async (span, onPart) => {
      await loadGate;
      try { await onPart("usage", new Map()); } catch (error) { stoppedEarly = true; throw error; }
      return null;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseLoad();
  assert.deepEqual((await done).computation, { index: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stoppedEarly, true, "the gone attempt's load is stopped at its next part");
  assert.deepEqual(spawned[0].posted, []);
  assert.deepEqual(spawned[1].posted, []);
});

test("a failure fails its owner with a closed code and aborts every other owner", async () => {
  for (const [label, act, code] of [
    ["failed", (worker) => worker.emit("message", { type: "failed", code: "ANALYTICS_V2_INPUT_INVALID" }),
      "ANALYTICS_V2_INPUT_INVALID"],
    ["unsafe code", (worker) => worker.emit("message", { type: "failed", code: "raw message with a value" }),
      "ANALYTICS_V2_REFRESH_WORKER_FAILED"],
    ["other error", (worker) => worker.emit("error", Object.assign(new Error("boom"), { code: "ERR_SOMETHING" })),
      "ANALYTICS_V2_REFRESH_WORKER_FAILED"],
    ["exit", (worker) => worker.emit("exit", 1), "ANALYTICS_V2_REFRESH_WORKER_EXITED"],
    ["protocol", (worker) => worker.emit("message", { type: "surprise" }), "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"],
  ]) {
    const { spawned, createWorker } = scriptedWorkers((worker, data) => {
      if (data.task.index === 0) setTimeout(() => act(worker), 2);
    });
    const pool = createAnalyticsRefreshOwnerPool(options({ workers: 1, memoryBudgetBytes: 100 * MIB,
      poolBytes: 4_096 * MIB, createWorker }));
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
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 1, memoryBudgetBytes: 100 * MIB,
    poolBytes: 4_096 * MIB, createWorker }));
  await assert.rejects(pool.compute(task(0, 10), {}, { ...io(), progress: () => { throw deadline; } }),
    { code: "ANALYTICS_V2_REFRESH_DEADLINE_EXCEEDED" });

  const source = Object.assign(new Error("ANALYTICS_V2_SOURCE_LIMIT"), { code: "ANALYTICS_V2_SOURCE_LIMIT" });
  const loads = scriptedWorkers((worker) => {
    worker.emit("message", { type: "load", id: 0, span: { fromDay: "2026-01-01", throughDay: "2026-01-02" } });
  });
  const loadPool = createAnalyticsRefreshOwnerPool(options({ workers: 1, memoryBudgetBytes: 100 * MIB,
    poolBytes: 4_096 * MIB, createWorker: loads.createWorker }));
  await assert.rejects(loadPool.compute(task(0, 10), {}, { ...io(), load: async () => { throw source; } }),
    { code: "ANALYTICS_V2_SOURCE_LIMIT" });
});

test("a task over the budget is refused before any Worker starts", async () => {
  const { spawned, createWorker } = scriptedWorkers(() => {});
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 2, memoryBudgetBytes: 100 * MIB,
    poolBytes: 4_096 * MIB, createWorker }));
  await assert.rejects(pool.compute(task(0, 101), {}, io()), { code: "ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID" });
  assert.equal(spawned.length, 0);
  await pool.abort();
});

test("waiting loads are served largest owner first, and a part carries its ordinal", async () => {
  const served = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { spawned, createWorker } = scriptedWorkers((worker, data) => {
    worker.on("_posted", (message) => { if (message.type === "loaded") result(worker, data.task.index); });
    worker.emit("message", { type: "load", id: 1, span: { fromDay: "2026-01-01", throughDay: "2026-01-01" } });
  });
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 4, memoryBudgetBytes: 1_000 * MIB,
    poolBytes: 16_384 * MIB, loadConcurrency: 1, createWorker }));
  const ioFor = (index) => ({
    ...io(),
    load: async (span, onPart) => {
      served.push(index);
      if (served.length === 1) await gate;
      await onPart("usage", new Map(), 3);
      return null;
    },
  });
  // Owner 0 (smallest) asks first and holds the one read slot; 1, 2 and 3 queue behind it.
  const running = [pool.compute(task(0, 10), {}, ioFor(0))];
  await new Promise((resolve) => setTimeout(resolve, 5));
  running.push(pool.compute(task(1, 20), {}, ioFor(1)), pool.compute(task(2, 300), {}, ioFor(2)),
    pool.compute(task(3, 40), {}, ioFor(3)));
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  await Promise.all(running);
  assert.deepEqual(served, [0, 2, 3, 1], "after the first, the largest estimate's load is served first");
  assert.deepEqual(spawned[0].posted[0], { type: "part", id: 1, ordinal: 3, stream: "usage", days: new Map() });
});

test("a Worker whose isolate did not get the asked heap limit (a process-wide heap flag) fails the run", async () => {
  for (const [label, reported, code] of [
    ["capped by --max-old-space-size", (limit) => 3_120 * MIB, "ANALYTICS_V2_REFRESH_WORKER_HEAP_LIMIT_UNAPPLIED"],
    ["raised by a flag", (limit) => limit + 2_048 * MIB, "ANALYTICS_V2_REFRESH_WORKER_HEAP_LIMIT_UNAPPLIED"],
    ["missing", () => undefined, "ANALYTICS_V2_REFRESH_WORKER_HEAP_LIMIT_UNAPPLIED"],
  ]) {
    const { createWorker } = scriptedWorkers((worker) => {
      worker.emit("message", { type: "heap", limitBytes: reported(worker.options.resourceLimits.maxOldGenerationSizeMb * MIB) });
    });
    const pool = createAnalyticsRefreshOwnerPool(options({ workers: 2, memoryBudgetBytes: 8_000 * MIB,
      poolBytes: 12_288 * MIB, createWorker }));
    await assert.rejects(pool.compute(task(0, 5_000), {}, io()), { code }, label);
  }
  // The limit V8 reports (old space plus the young generation) passes.
  const { createWorker } = scriptedWorkers((worker, data) => {
    worker.emit("message", { type: "heap", limitBytes: (worker.options.resourceLimits.maxOldGenerationSizeMb
      + worker.options.resourceLimits.maxYoungGenerationSizeMb) * MIB });
    result(worker, data.task.index);
  });
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 2, memoryBudgetBytes: 8_000 * MIB,
    poolBytes: 12_288 * MIB, createWorker }));
  assert.deepEqual((await pool.compute(task(0, 5_000), {}, io())).computation, { index: 0 });
});


test("a result keeps its Worker charged until termination; abort awaits detached Workers", async () => {
  const { spawned, createWorker } = scriptedWorkers(() => {});
  const stops = [];
  const deferredWorker = (url, config) => {
    const worker = createWorker(url, config);
    worker.terminate = () => new Promise((resolve) => { stops.push(resolve); });
    return worker;
  };
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 1, memoryBudgetBytes: 1_000 * MIB,
    poolBytes: chargeMiB(1_000) * MIB, createWorker: deferredWorker }));
  const first = pool.compute(task(0, 1_000), {}, io());
  const second = pool.compute(task(1, 1_000), {}, io());
  const rejected = assert.rejects(second, { code: "ANALYTICS_V2_REFRESH_WORKER_ABORTED" });
  await new Promise((resolve) => setImmediate(resolve));
  result(spawned[0], 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.running, 1, "the outgoing isolate still occupies its slot");
  assert.equal(spawned.length, 1, "replacement cannot overlap termination");
  let aborted = false;
  const stopping = pool.abort().then(() => { aborted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, false, "abort awaits the already detached isolate");
  stops[0](0);
  await Promise.all([first, rejected, stopping]);
  assert.equal(pool.running, 0);
  assert.equal(aborted, true);
});

test("an alone OOM retry waits for the failed isolate's termination", async () => {
  const { spawned, createWorker } = scriptedWorkers(() => {});
  let stopFirst;
  const deferredWorker = (url, config) => {
    const worker = createWorker(url, config);
    if (spawned.length === 1) worker.terminate = () => new Promise((resolve) => { stopFirst = resolve; });
    return worker;
  };
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 2, memoryBudgetBytes: 1_000 * MIB,
    poolBytes: 4_000 * MIB, createWorker: deferredWorker }));
  const computed = pool.compute(task(0, 1_000), {}, io());
  await new Promise((resolve) => setImmediate(resolve));
  spawned[0].emit("error", Object.assign(new Error("synthetic OOM"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 1, "retry cannot overlap the outgoing isolate");
  assert.equal(pool.running, 1);
  stopFirst(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 2);
  assert.equal(pool.stats().retriedAlone, 1);
  result(spawned[1], 0);
  await computed;
  await pool.abort();
});


test("abort drains a load already reading before it lets snapshot readers close", async () => {
  const { spawned, createWorker } = scriptedWorkers((worker) => {
    worker.emit("message", { type: "load", id: 1, span: { fromDay: "2026-01-01", throughDay: "2026-01-01" } });
  });
  let finishRead;
  const started = new Promise((resolve) => { finishRead = resolve; });
  let releaseRead;
  const reading = new Promise((resolve) => { releaseRead = resolve; });
  const pool = createAnalyticsRefreshOwnerPool(options({ workers: 1, memoryBudgetBytes: 1_000 * MIB,
    poolBytes: 4_000 * MIB, createWorker }));
  const computed = pool.compute(task(0, 10), {}, {
    ...io(), load: async (span, onPart) => {
      finishRead();
      await reading;
      await onPart("usage", new Map([[span.fromDay, []]]), 0);
    },
  });
  const rejected = assert.rejects(computed, { code: "ANALYTICS_V2_REFRESH_WORKER_ABORTED" });
  await started;
  let drained = false;
  const stopping = pool.abort().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "reader remains in flight after Worker termination");
  releaseRead();
  await Promise.all([rejected, stopping]);
  assert.equal(drained, true);
  assert.equal(spawned[0].posted.length, 0, "no late part is delivered to the terminated Worker");
});
