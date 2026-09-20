import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";

import {
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import {
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";
import {
  readLocalUnifiedCompanionProjection,
} from "../src/local-unified-companion-source.js";
import {
  readLocalUnifiedCompanionProjectionOffMain,
  createLocalUnifiedCompanionProjectionReader,
  shouldRunLocalUnifiedCompanionProjectionOffMain,
} from "../src/local-unified-companion-off-main.js";
import {
  createCachedLocalUnifiedProjectionReader,
} from "../apps/local/server.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const NOW_MS = Date.parse("2026-08-24T01:00:00.000Z");

function rolloutFixture() {
  const rows = [
    {
      timestamp: "2026-08-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: THREAD_ID,
        session_id: THREAD_ID,
        thread_source: "user",
        originator: "codex_cli_rs",
      },
    },
    {
      timestamp: "2026-08-24T00:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "high" },
    },
    {
      timestamp: "2026-08-24T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 10,
            window_minutes: 300,
            resets_at: 1_777_000_000,
          },
        },
      },
    },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function createProjectionIndex(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sessions = join(root, "sessions", "2026", "08", "24");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`),
    rolloutFixture(),
  );
  const indexFile = join(root, "index.sqlite");
  await rebuildLocalUnifiedIndex({
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: "companion-off-main-test-v1",
  });
  return { root, indexFile };
}

test("only a full native macOS projection selects the worker boundary", () => {
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "darwin",
    mode: "full",
  }), true);
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "darwin",
    mode: "deferred",
  }), false);
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "linux",
    mode: "full",
  }), false);
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "win32",
    mode: "full",
  }), false);
});

test("deferred projection stays cheap and never constructs a worker", async () => {
  class RefusingWorker {
    constructor() {
      throw new Error("worker must not start");
    }
  }
  const projection = await readLocalUnifiedCompanionProjectionOffMain({
    indexFile: "/does/not/matter.sqlite",
    nowMs: NOW_MS,
    mode: "deferred",
  }, {
    platform: "darwin",
    WorkerClass: RefusingWorker,
  });
  assert.equal(projection.status, "deferred");
  assert.equal(projection.errorCode, "local_unified_index_deferred");
});

test("the real projection worker preserves the direct reader contract", async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-off-main-contract-",
  );
  let workerCount = 0;
  class CapturingWorker extends Worker {
    constructor(...arguments_) {
      super(...arguments_);
      workerCount += 1;
    }
  }
  try {
    const options = { indexFile, nowMs: NOW_MS, mode: "full" };
    const [direct, offMain] = await Promise.all([
      readLocalUnifiedCompanionProjection(options),
      readLocalUnifiedCompanionProjectionOffMain(options, {
        platform: "darwin",
        WorkerClass: CapturingWorker,
      }),
    ]);
    assert.equal(workerCount, 1);
    assert.deepEqual(
      { ...offMain, readWallMs: null },
      { ...direct, readWallMs: null },
    );
    assert.equal(offMain.status, "available");
    assert.equal(offMain.usageEvents, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real unchanged publication reuses the completed projection without another worker read", async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-projection-cache-",
  );
  let workerReads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async (options, controls) => {
      workerReads += 1;
      return readLocalUnifiedCompanionProjectionOffMain(options, {
        ...controls,
        platform: "darwin",
      });
    },
  });
  try {
    const options = {
      indexFile,
      nowMs: NOW_MS,
      declaredSpeedBaselines: [],
      mode: "full",
    };
    const first = await reader(options);
    assert.equal(first.status, "available");
    assert.equal(workerReads, 1);

    const second = await reader(
      { ...options, nowMs: NOW_MS + 1_000 },
      {
        reuse: {
          generationFingerprint: first.generation.fingerprint,
        },
      },
    );
    assert.equal(second.status, "available");
    assert.equal(second.generation.fingerprint, first.generation.fingerprint);
    assert.equal(workerReads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large synchronous SQLite projection does not block the companion loop", {
  timeout: 30_000,
}, async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-off-main-responsive-",
  );
  const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
  const insert = database.prepare(`
    INSERT INTO quota_observation(
      observed_at_ms, limit_id, slot, plan_type, used_percent,
      resets_at_ms, duration_mins
    ) VALUES (?, 'codex', 'secondary', 'pro', ?, ?, 300)
  `);
  const rowCount = 150_000;
  try {
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < rowCount; index += 1) {
      insert.run(
        NOW_MS - rowCount * 1_000 + index * 1_000,
        index % 101,
        NOW_MS + 300 * 60_000,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the insertion failure.
    }
    throw error;
  } finally {
    database.close();
  }

  let heartbeats = 0;
  let maximumHeartbeatGapMs = 0;
  let priorHeartbeatAt = performance.now();
  const heartbeat = setInterval(() => {
    const observedAt = performance.now();
    maximumHeartbeatGapMs = Math.max(
      maximumHeartbeatGapMs,
      observedAt - priorHeartbeatAt,
    );
    priorHeartbeatAt = observedAt;
    heartbeats += 1;
  }, 20);
  const startedAt = performance.now();
  try {
    const projection = await readLocalUnifiedCompanionProjectionOffMain({
      indexFile,
      nowMs: NOW_MS,
      mode: "full",
    }, { platform: "darwin" });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(projection.status, "available");
    assert.equal(projection.quotaObservations, rowCount + 1);
    assert.ok(elapsedMs >= 100, `projection completed unexpectedly fast in ${elapsedMs}ms`);
    assert.ok(heartbeats >= 3, `only ${heartbeats} loop heartbeats during ${elapsedMs}ms`);
    assert.ok(
      maximumHeartbeatGapMs < 500,
      `companion loop heartbeat stalled for ${maximumHeartbeatGapMs}ms`,
    );
  } finally {
    clearInterval(heartbeat);
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled read-only projection terminates with a bounded typed error", async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-off-main-abort-",
  );
  const controller = new AbortController();
  try {
    const reading = readLocalUnifiedCompanionProjectionOffMain({
      indexFile,
      nowMs: NOW_MS,
      mode: "full",
    }, { platform: "darwin", signal: controller.signal });
    controller.abort();
    await assert.rejects(
      reading,
      (error) => error?.code === "local_unified_companion_projection_aborted",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent real worker reuses its lifetime while preserving repeated projection results", async () => {
  const { root, indexFile } = await createProjectionIndex("unified-companion-persistent-");
  let starts = 0;
  class CountingWorker extends Worker {
    constructor(...args) { super(...args); starts += 1; }
  }
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin", WorkerClass: CountingWorker });
  try {
    const options = { indexFile, nowMs: NOW_MS, includeWorkUsage: true, codexHome: root, secretFile: join(root, "salt") };
    const first = await reader(options);
    const second = await reader(options);
    const direct = await readLocalUnifiedCompanionProjection(options);
    assert.equal(first.workUsage.status, "available");
    const withoutReadTimings = (projection) => JSON.parse(JSON.stringify(projection, function (key, value) {
      return key === "readWallMs" || (key === "observedAt" && this.resolverVersion) ? null : value;
    }));
    assert.deepEqual(withoutReadTimings(first), withoutReadTimings(second));
    assert.deepEqual(withoutReadTimings(first), withoutReadTimings(direct));
    assert.equal(starts, 1);
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("persistent deferred reads never construct a worker", async () => {
  class RefusingWorker { constructor() { throw new Error("must not start"); } }
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin", WorkerClass: RefusingWorker });
  try {
    assert.equal((await reader({ indexFile: "/absent", mode: "deferred" })).status, "deferred");
    assert.equal((await reader({ indexFile: "/absent", mode: "deferred" })).status, "deferred");
  } finally { await reader.close(); }
});

test("direct fallback cancels active reads, recovers, and closes outstanding reads", async () => {
  const { root, indexFile } = await createProjectionIndex("unified-companion-persistent-direct-");
  class RefusingWorker { constructor() { throw new Error("must not start"); } }
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "linux", WorkerClass: RefusingWorker });
  try {
    const controller = new AbortController();
    const options = { indexFile, nowMs: NOW_MS, includeWorkUsage: true, codexHome: root, secretFile: join(root, "salt") };
    const active = reader(options, { signal: controller.signal });
    const cancelled = assert.rejects(active, { code: "local_unified_companion_projection_aborted" });
    controller.abort();
    const recovered = reader(options);
    await cancelled;
    assert.equal((await recovered).workUsage.status, "available");
    const closing = reader(options);
    const closed = assert.rejects(closing, { code: "local_unified_companion_projection_reader_closed" });
    await reader.close();
    await closed;
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("active persistent worker cancellation discards it and a retry recovers", async () => {
  const { root, indexFile } = await createProjectionIndex("unified-companion-persistent-abort-");
  let starts = 0;
  class CountingWorker extends Worker {
    constructor(...args) { super(...args); starts += 1; }
  }
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin", WorkerClass: CountingWorker });
  const controller = new AbortController();
  try {
    const cancelled = reader({ indexFile, nowMs: NOW_MS }, { signal: controller.signal });
    const assertion = assert.rejects(cancelled, { code: "local_unified_companion_projection_aborted" });
    controller.abort();
    const next = reader({ indexFile, nowMs: NOW_MS });
    await assertion;
    assert.equal((await next).status, "available");
    assert.equal(starts, 2);
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("queued cancellation is prompt, preserves active work, and close rejects all outstanding reads", async () => {
  let instance;
  class HeldWorker extends EventEmitter {
    constructor() { super(); instance = this; this.requests = []; this.terminations = 0; }
    postMessage(message) { this.requests.push(message); }
    terminate() { this.terminations += 1; return Promise.resolve(1); }
    ref() {}
    unref() {}
  }
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin", WorkerClass: HeldWorker, maxQueueSize: 1 });
  const active = reader({ indexFile: "/absent" });
  const activeAssertion = assert.rejects(active, { code: "local_unified_companion_projection_reader_closed" });
  const controller = new AbortController();
  const queued = reader({ indexFile: "/absent" }, { signal: controller.signal });
  const cancelledAssertion = assert.rejects(queued, { code: "local_unified_companion_projection_aborted" });
  await assert.rejects(reader({ indexFile: "/absent" }), { code: "local_unified_companion_projection_queue_full" });
  controller.abort();
  await cancelledAssertion;
  assert.equal(instance.requests.length, 1);
  assert.equal(instance.terminations, 0);
  const remaining = reader({ indexFile: "/absent" });
  const remainingAssertion = assert.rejects(remaining, { code: "local_unified_companion_projection_reader_closed" });
  await reader.close();
  await Promise.all([activeAssertion, remainingAssertion]);
  assert.equal(instance.terminations, 1);
  await assert.rejects(reader({ indexFile: "/absent" }), { code: "local_unified_companion_projection_reader_closed" });
  await reader.close();
});

test("unexpected persistent worker exit rejects the active read and the next request recovers", async () => {
  const { root, indexFile } = await createProjectionIndex("unified-companion-persistent-exit-");
  let instance;
  class CapturingWorker extends Worker { constructor(...args) { super(...args); instance = this; } }
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin", WorkerClass: CapturingWorker });
  try {
    const failed = reader({ indexFile, nowMs: NOW_MS });
    const assertion = assert.rejects(failed, { code: "local_unified_companion_projection_worker_failed" });
    await instance.terminate();
    await assertion;
    assert.equal((await reader({ indexFile, nowMs: NOW_MS })).status, "available");
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("an uncloneable request fails with a fixed code and does not poison the reusable reader", async () => {
  const { root, indexFile } = await createProjectionIndex("unified-companion-persistent-clone-");
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin" });
  try {
    await assert.rejects(reader({ indexFile, declaredSpeedBaselines: [() => {}] }), {
      code: "local_unified_companion_projection_worker_failed",
    });
    assert.equal((await reader({ indexFile, nowMs: NOW_MS })).status, "available");
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("idle reusable workers are unreferenced and retire after a bounded timeout", async () => {
  let instance;
  class CompletingWorker extends EventEmitter {
    constructor() { super(); instance = this; this.refs = 0; this.unrefs = 0; this.terminations = 0; }
    postMessage({ requestId }) { queueMicrotask(() => this.emit("message", { type: "result", requestId, result: { status: "available" } })); }
    ref() { this.refs += 1; }
    unref() { this.unrefs += 1; }
    terminate() { this.terminations += 1; return Promise.resolve(0); }
  }
  const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin", WorkerClass: CompletingWorker, idleTimeoutMs: 10 });
  try {
    await reader({ indexFile: "/absent" });
    assert.equal(instance.refs, 1);
    assert.equal(instance.unrefs, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(instance.terminations, 1);
  } finally { await reader.close(); }
});

for (const failure of ["error", "messageerror", "protocol"]) {
  test(`persistent worker ${failure} failure is bounded and a queued read recovers`, async () => {
    let starts = 0;
    class FailingWorker extends EventEmitter {
      constructor() { super(); this.first = ++starts === 1; }
      postMessage({ requestId }) {
        queueMicrotask(() => {
          if (!this.first) this.emit("message", { type: "result", requestId, result: { status: "available" } });
          else if (failure === "protocol") this.emit("message", { type: "result", requestId: requestId + 1 });
          else this.emit(failure, new Error("private details must not escape"));
        });
      }
      ref() {}
      unref() {}
      terminate() { return Promise.resolve(1); }
    }
    const reader = createLocalUnifiedCompanionProjectionReader({ platform: "darwin", WorkerClass: FailingWorker });
    try {
      const failed = assert.rejects(reader({ indexFile: "/absent" }), {
        message: "local_unified_companion_projection_worker_failed",
        code: "local_unified_companion_projection_worker_failed",
      });
      const recovered = reader({ indexFile: "/absent" });
      await failed;
      assert.equal((await recovered).status, "available");
      assert.equal(starts, 2);
    } finally { await reader.close(); }
  });
}
