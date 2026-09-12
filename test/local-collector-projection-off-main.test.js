import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import {
  commitLocalCollectorState,
  defaultLocalCollectorStatePath,
} from "../src/local-collector-state.js";
import {
  readLocalCollectorProjection,
} from "../src/local-collector-projection.js";
import {
  readLocalCollectorProjectionOffMain,
} from "../src/local-collector-projection-off-main.js";

const NOW_MS = Date.parse("2026-09-07T12:00:00.000Z");

function usageRecord(index = 0) {
  return {
    schemaVersion: "0.3",
    kind: "codex_rollout_usage_snapshot",
    observedAt: new Date(NOW_MS - (index + 10) * 60_000).toISOString(),
    eventKey: `usage-${index}`,
    model: "gpt-5.6-sol",
    components: {
      input_uncached_tokens: 10 + index,
      input_cache_read_tokens: 0,
      input_cache_write_tokens: 0,
      output_text_tokens: 2,
      output_reasoning_tokens: 0,
    },
    tierSemantics: { codexSpeedMode: "standard" },
  };
}

function quotaRecord() {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    observedAt: new Date(NOW_MS - 30_000).toISOString(),
    eventKey: "quota-1",
    accountScope: { status: "unavailable" },
    windows: [{
      limitId: "codex",
      slot: "secondary",
      planType: "pro",
      usedPercent: 21,
      windowDurationMins: 10_080,
      resetsAt: Math.floor((NOW_MS + 6 * 24 * 60 * 60 * 1_000) / 1_000),
    }],
  };
}

function toolRecord(index, { toolClass = "subagent" } = {}) {
  return {
    schemaVersion: "0.3",
    kind: "codex_tool_class_event",
    observedAt: new Date(NOW_MS - (index + 1) * 1_000).toISOString(),
    eventKey: `tool-${index}`,
    toolClass,
  };
}

async function createCollectorState(prefix, records) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const stateFile = defaultLocalCollectorStatePath(root);
  await commitLocalCollectorState({
    stateFile,
    checkpoint: {},
    records,
    clock: () => NOW_MS,
  });
  return { root, stateFile };
}

test("collector worker entrypoint leaves unrelated worker data and parent channels intact", async () => {
  const messages = [];
  const worker = new Worker(
    new URL("./fixtures/local-collector-projection-unrelated-worker.mjs", import.meta.url),
    {
      workerData: { value: "unrelated" },
      execArgv: [],
    },
  );
  try {
    worker.on("message", (message) => messages.push(message));
    const exitCode = await new Promise((resolve) => worker.once("exit", resolve));
    assert.equal(exitCode, 0);
    assert.deepEqual(messages, [{ type: "unrelated_worker_reply", value: true }]);
  } finally {
    await worker.terminate().catch(() => {});
  }
});

test("worker collector projection exactly preserves available, unknown, and unavailable result fields", async () => {
  const { root, stateFile } = await createCollectorState(
    "collector-projection-off-main-parity-",
    [
      usageRecord(),
      quotaRecord(),
      toolRecord(1),
      toolRecord(2, { toolClass: "unrecognized-private-tool" }),
    ],
  );
  try {
    for (const summarizeUsageEvents of [true, false]) {
      const options = {
        stateFile,
        nowMs: NOW_MS,
        summarizeUsageEvents,
        declaredSpeedBaselines: [],
      };
      const [direct, offMain] = await Promise.all([
        readLocalCollectorProjection(
          options.stateFile,
          options.nowMs,
          options,
        ),
        readLocalCollectorProjectionOffMain(options),
      ]);
      assert.deepEqual(offMain, direct);
      assert.equal(offMain.status, "available");
      assert.equal(offMain.quota.accountAttribution, "unattributed");
      assert.equal(offMain.tools.counts.other, 1);
      assert.equal(JSON.stringify(offMain).includes("unrecognized-private-tool"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and unavailable collector states retain their closed outcomes across the worker boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-projection-off-main-state-"));
  const missingStateFile = defaultLocalCollectorStatePath(root);
  const missingOptions = {
    stateFile: missingStateFile,
    nowMs: NOW_MS,
    summarizeUsageEvents: false,
  };
  try {
    const [direct, offMain] = await Promise.all([
      readLocalCollectorProjection(
        missingOptions.stateFile,
        missingOptions.nowMs,
        missingOptions,
      ),
      readLocalCollectorProjectionOffMain(missingOptions),
    ]);
    assert.deepEqual(offMain, direct);
    assert.equal(offMain.status, "missing");
    assert.equal(offMain.quota.status, "unavailable");

    await mkdir(join(root, ".usage-monitor"), { recursive: true });
    const unavailableStateFile = join(root, ".usage-monitor", "collector-state.sqlite");
    await mkdir(unavailableStateFile);
    const unavailableOptions = { ...missingOptions, stateFile: unavailableStateFile };
    await assert.rejects(
      readLocalCollectorProjection(
        unavailableOptions.stateFile,
        unavailableOptions.nowMs,
        unavailableOptions,
      ),
      (error) => error?.code === "collector_unavailable"
        && error.message === "collector_unavailable",
    );
    await assert.rejects(
      readLocalCollectorProjectionOffMain(unavailableOptions),
      (error) => error?.code === "collector_unavailable"
        && error.message === "collector_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large synchronous collector traversal leaves the companion event loop responsive", {
  timeout: 30_000,
}, async () => {
  const recordCount = 80_000;
  const records = Array.from({ length: recordCount }, (_, index) => toolRecord(index));
  const { root, stateFile } = await createCollectorState(
    "collector-projection-off-main-responsive-",
    records,
  );
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
    const projection = await readLocalCollectorProjectionOffMain({
      stateFile,
      nowMs: NOW_MS,
      summarizeUsageEvents: false,
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(projection.status, "available");
    assert.equal(projection.recordCount, recordCount);
    assert.equal(projection.tools.total, recordCount);
    assert.ok(elapsedMs >= 80, `projection completed unexpectedly fast in ${elapsedMs}ms`);
    assert.ok(heartbeats >= 3, `only ${heartbeats} loop heartbeats during ${elapsedMs}ms`);
    assert.ok(
      maximumHeartbeatGapMs < 300,
      `companion loop heartbeat stalled for ${maximumHeartbeatGapMs}ms`,
    );
  } finally {
    clearInterval(heartbeat);
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting a collector projection terminates the worker and rejects with a bounded fixed error", async () => {
  const { root, stateFile } = await createCollectorState(
    "collector-projection-off-main-abort-",
    Array.from({ length: 20_000 }, (_, index) => toolRecord(index)),
  );
  const controller = new AbortController();
  let terminated = 0;
  class TrackingWorker extends Worker {
    terminate(...arguments_) {
      terminated += 1;
      return super.terminate(...arguments_);
    }
  }
  const startedAt = performance.now();
  try {
    const reading = readLocalCollectorProjectionOffMain({
      stateFile,
      nowMs: NOW_MS,
      summarizeUsageEvents: false,
    }, {
      signal: controller.signal,
      WorkerClass: TrackingWorker,
    });
    controller.abort();
    await assert.rejects(
      reading,
      (error) => error?.code === "local_collector_projection_aborted"
        && error.message === "local_collector_projection_aborted",
    );
    assert.ok(terminated >= 1);
    assert.ok(
      performance.now() - startedAt < 1_000,
      "aborted worker did not settle within the fixed deadline",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed worker output is terminated and reduced to a bounded content-free error", async () => {
  let instance = null;
  class NonClosingWorker extends EventEmitter {
    constructor() {
      super();
      instance = this;
      queueMicrotask(() => {
        this.emit("message", {
          type: "result",
          result: { privateRow: "/Users/private/collector.sqlite" },
          unexpected: "person@example.com",
        });
      });
    }

    terminate() {
      this.terminated = (this.terminated ?? 0) + 1;
      return Promise.resolve(1);
    }
  }
  const startedAt = performance.now();
  await assert.rejects(
    readLocalCollectorProjectionOffMain({
      stateFile: "/private/collector.sqlite",
      nowMs: NOW_MS,
    }, { WorkerClass: NonClosingWorker }),
    (error) => error?.code === "local_collector_projection_worker_failed"
      && error.message === "local_collector_projection_worker_failed"
      && !error.message.includes("/Users/")
      && !error.message.includes("@"),
  );
  assert.equal(instance?.terminated, 1);
  assert.ok(
    performance.now() - startedAt < 1_000,
    "malformed worker output did not settle within the fixed deadline",
  );
});
