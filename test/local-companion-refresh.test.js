import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalCollectorRefreshRunner,
  LocalCompanionRefreshController,
} from "../src/local-companion-refresh.js";

const COMPLETE_INDEX = Object.freeze({
  mode: "recent_7d",
  status: "recent_7d_complete",
  phase: "complete",
  boundedBy: "modified_at_and_collection_start",
  filesDiscovered: 9,
  filesSelected: 4,
  filesProcessed: 4,
  recordsWritten: 12,
  coveredAt: {
    startAt: "2026-07-16T12:00:00.000Z",
    endAt: "2026-07-23T12:00:00.000Z",
  },
});

test("local refresh requests a bounded recent index and returns only safe progress", async () => {
  let options;
  const controller = new AbortController();
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: async () => Buffer.alloc(32, 7),
    }),
    runCollector: async (value) => {
      options = value;
      await value.onProgress(COMPLETE_INDEX);
      return {
        rolloutRecordsWritten: 12,
        filesDiscovered: 9,
        refresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        indexing: {
          ...COMPLETE_INDEX,
          privatePath: "/private/must-not-escape",
        },
      };
    },
  });

  const result = await runner({
    signal: controller.signal,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(options.backfill, true);
  assert.equal(options.backfillSinceAt, "2026-07-16T12:00:00.000Z");
  assert.equal(options.signal, controller.signal);
  assert.equal(progress.length, 1);
  assert.deepEqual(progress[0], COMPLETE_INDEX);
  assert.equal(result.rolloutRecordsWritten, 12);
  assert.deepEqual(result.indexing, COMPLETE_INDEX);
  assert.equal(JSON.stringify(result).includes("/private/"), false);
});

test("refresh controller publishes bounded progress and reloads after success", async () => {
  let reloads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 2,
        recordsWritten: 5,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      await gate;
      return {
        rolloutRecordsWritten: 7,
        filesDiscovered: 9,
        quotaRefresh: {
          attempted: true,
          recordWritten: false,
          errorCode: "temporary_disconnect",
        },
        indexing: COMPLETE_INDEX,
      };
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getStatus().status, "running");
  assert.equal(controller.getStatus().progress.status, "recent_7d_indexing");
  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "succeeded");
  assert.equal(status.progress.status, "recent_7d_complete");
  assert.deepEqual(status.result.indexing, COMPLETE_INDEX);
  assert.equal(reloads, 1);
});

test("refresh timeout aborts collector work and retains only safe progress", async () => {
  let observedAbort = false;
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          indexing: {
            ...COMPLETE_INDEX,
            status: "bounded_pause",
            phase: "paused",
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
          },
        });
      }, { once: true });
    }),
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    timeoutMs: 1_000,
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const status = controller.getStatus();
  assert.equal(observedAbort, true);
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_timed_out");
  assert.equal(status.progress.status, "bounded_pause");
  assert.equal(status.progress.recordsWritten, 2);
  assert.equal(status.result.indexing.status, "bounded_pause");
  assert.equal(reloads, 1);
  assert.equal(JSON.stringify(status).includes("/private/"), false);
});
