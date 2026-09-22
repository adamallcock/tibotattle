import test from "node:test";
import assert from "node:assert/strict";
import { createAccountlessContributionScheduler } from "../src/application/index.js";
import { LocalCompanionRefreshController } from "../src/local-companion-refresh.js";

const origin = "http://127.0.0.1:18765";
const ready = Object.freeze({ available: true, current: true, enabled: true,
  policyVersion: "accountless-opt-out-v1", destinationOrigin: origin });
const publication = Object.freeze({ status: "ingested", unchanged: false,
  generation: Object.freeze({
    id: 2, fingerprint: `generation-v2-${"a".repeat(64)}`, status: "complete",
    discoveryComplete: true, diagnosticsComplete: true, usageProvenanceComplete: true,
    sourceOrderComplete: true, quotaProvenanceComplete: true, toolProvenanceComplete: true,
  }) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function timers() {
  let now = Date.parse("2026-09-22T12:00:00.000Z");
  let nextId = 0;
  const pending = new Map();
  return {
    now: () => now,
    pending,
    setTimer(fn, delay) {
      const id = ++nextId;
      pending.set(id, { fn, due: now + delay });
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    advanceBy(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, timer]) => timer.due <= until)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].due;
        next[1].fn();
      }
      now = until;
    },
  };
}

async function settle(controller) {
  for (let attempts = 0; attempts < 100 && controller.isRunning(); attempts++) await tick();
  assert.equal(controller.isRunning(), false, "refresh must reach a terminal state");
}

test("detailed publication reload wakes an idle uploader within one minute using the new index", async () => {
  const clock = timers();
  let generation = 1;
  const uploads = [];
  const scheduler = createAccountlessContributionScheduler({ origin, ...clock,
    readPreference: async () => ready,
    runner: async () => { uploads.push(generation); return { status: "complete", chunksUploaded: 1 }; },
  });
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({ unifiedIndex: publication }),
    dataStore: { async reload() { generation = 2; } },
    onIndexPublished: scheduler.notifyIndexPublished,
  });
  try {
    scheduler.start();
    await scheduler.runNow();
    controller.start({ mode: "detailed" });
    await settle(controller);
    assert.equal(controller.getStatus().status, "succeeded");
    assert.deepEqual(uploads, [1]);
    clock.advanceBy(59_999);
    await tick();
    assert.deepEqual(uploads, [1]);
    clock.advanceBy(1);
    await tick();
    assert.deepEqual(uploads, [1, 2]);
    assert.equal(scheduler.inspect().state, "up_to_date");
  } finally { await scheduler.stop(); }
});

test("publication during an upload never overlaps it and the follow-up captures the new index", async () => {
  const clock = timers();
  let generation = 1;
  let finish;
  let active = 0;
  let maximumActive = 0;
  const uploads = [];
  const scheduler = createAccountlessContributionScheduler({ origin, ...clock,
    readPreference: async () => ready,
    runner: async () => {
      uploads.push(generation);
      maximumActive = Math.max(maximumActive, ++active);
      if (uploads.length === 1) await new Promise((resolve) => { finish = resolve; });
      active--;
      return { status: "complete", chunksUploaded: 1 };
    },
  });
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({ unifiedIndex: publication }),
    dataStore: { async reload() { generation = 2; } },
    onIndexPublished: scheduler.notifyIndexPublished,
  });
  try {
    scheduler.start();
    const first = scheduler.runNow();
    await tick();
    controller.start({ mode: "detailed" });
    await settle(controller);
    assert.deepEqual(uploads, [1]);
    finish();
    await first;
    assert.equal(scheduler.inspect().state, "pending");
    clock.advanceBy(60_000);
    await tick();
    assert.deepEqual(uploads, [1, 2]);
    assert.equal(maximumActive, 1);
  } finally { await scheduler.stop(); }
});

test("a real refresh publication preserves a server Retry-After deadline", async () => {
  const clock = timers();
  let calls = 0;
  const scheduler = createAccountlessContributionScheduler({ origin, ...clock,
    readPreference: async () => ready,
    runner: async () => {
      calls++;
      return { status: "failed", failure: { retryable: true, retryAfterMilliseconds: 600_000 } };
    },
  });
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({ unifiedIndex: publication }),
    dataStore: { async reload() {} },
    onIndexPublished: scheduler.notifyIndexPublished,
  });
  try {
    scheduler.start();
    await scheduler.runNow();
    const deadline = scheduler.inspect().nextAttemptAt;
    controller.start({ mode: "detailed" });
    await settle(controller);
    assert.equal(scheduler.inspect().nextAttemptAt, deadline);
    assert.equal(scheduler.inspect().state, "retry_wait");
    clock.advanceBy(599_999);
    await tick();
    assert.equal(calls, 1);
    clock.advanceBy(1);
    await tick();
    assert.equal(calls, 2);
  } finally { await scheduler.stop(); }
});

test("quick, unchanged, cancelled and failed refreshes cannot accelerate uploads", async (t) => {
  for (const outcome of ["quick", "unchanged", "cancelled_reload", "failed_reload"]) {
    await t.test(outcome, async () => {
      const clock = timers();
      let calls = 0;
      const scheduler = createAccountlessContributionScheduler({ origin, ...clock,
        readPreference: async () => ready,
        runner: async () => { calls++; return { status: "complete", chunksUploaded: 0 }; },
      });
      const controller = new LocalCompanionRefreshController({
        runner: async () => ({ unifiedIndex: { ...publication, unchanged: outcome === "unchanged" } }),
        dataStore: { async reload() {
          if (outcome === "cancelled_reload") controller.cancel();
          if (outcome === "failed_reload") throw new Error("synthetic reload failure");
        } },
        onIndexPublished: scheduler.notifyIndexPublished,
      });
      try {
        scheduler.start();
        await scheduler.runNow();
        const deadline = scheduler.inspect().nextAttemptAt;
        controller.start({ mode: outcome === "quick" ? "quick" : "detailed" });
        await settle(controller);
        assert.equal(scheduler.inspect().nextAttemptAt, deadline);
        if (outcome === "cancelled_reload") assert.equal(controller.getStatus().status, "cancelled");
        if (outcome === "failed_reload") assert.equal(controller.getStatus().status, "failed");
        clock.advanceBy(60_000);
        await tick();
        assert.equal(calls, 1);
      } finally { await scheduler.stop(); }
    });
  }
});
