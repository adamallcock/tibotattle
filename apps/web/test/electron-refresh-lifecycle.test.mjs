import assert from "node:assert/strict";
import test from "node:test";

import {
  createElectronRefreshLease,
  ELECTRON_REFRESH_HEARTBEAT_INTERVAL_MS,
  ELECTRON_REFRESH_SIGNAL_TIMEOUT_MS,
} from "../public/electron-refresh-lifecycle.js";

function fakeScheduler() {
  let nextId = 0;
  const tasks = [];
  return {
    tasks,
    schedule(callback, delay) {
      const task = { id: ++nextId, callback, delay, cancelled: false };
      tasks.push(task);
      return task;
    },
    cancel(task) {
      task.cancelled = true;
    },
    fire(delay) {
      const task = tasks.find((candidate) => !candidate.cancelled && candidate.delay === delay);
      assert.ok(task, `expected active ${delay} ms timer`);
      task.cancelled = true;
      task.callback();
      return task;
    },
  };
}

test("renderer lease sends exact mode, numeric heartbeats, and idempotent settlement", async () => {
  const scheduler = fakeScheduler();
  const calls = [];
  const states = [];
  const lease = createElectronRefreshLease({
    bridge: {
      refreshStarted(mode) {
        calls.push(["start", mode]);
        return 17;
      },
      refreshHeartbeat(value) {
        calls.push(["heartbeat", value]);
        return true;
      },
      refreshSettled(value) {
        calls.push(["settle", value]);
        return true;
      },
    },
    mode: "detailed",
    onState: (value) => states.push(value),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  assert.equal(await lease.start(), 17);
  assert.deepEqual(calls, [["start", "detailed"]]);
  scheduler.fire(ELECTRON_REFRESH_HEARTBEAT_INTERVAL_MS);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [["start", "detailed"], ["heartbeat", 17]]);
  assert.equal(await lease.finish(), true);
  assert.equal(await lease.finish(), true);
  assert.deepEqual(calls, [
    ["start", "detailed"],
    ["heartbeat", 17],
    ["settle", 17],
  ]);
  assert.equal(states.at(-1).state, "settled");
  assert.equal(states.some((value) => Object.hasOwn(value, "lease")), false);
});

test("a late start reply is settled after the renderer has already finished", async () => {
  const scheduler = fakeScheduler();
  let releaseStart;
  const startReply = new Promise((resolve) => { releaseStart = resolve; });
  const settled = [];
  const states = [];
  const lease = createElectronRefreshLease({
    bridge: {
      refreshStarted: () => startReply,
      refreshHeartbeat: () => true,
      refreshSettled(value) {
        settled.push(value);
        return true;
      },
    },
    mode: "quick",
    onState: (value) => states.push(value),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  const start = lease.start();
  scheduler.fire(ELECTRON_REFRESH_SIGNAL_TIMEOUT_MS);
  assert.equal(await start, null);
  assert.equal(await lease.finish(), false);
  assert.equal(states.at(-1).reason, "start_reply_delayed");
  releaseStart(23);
  await new Promise(setImmediate);
  assert.deepEqual(settled, [23]);
  assert.equal(states.at(-1).state, "settled");
});

test("failed heartbeat and settlement remain visible while main recovery stays authoritative", async () => {
  const scheduler = fakeScheduler();
  const states = [];
  const lease = createElectronRefreshLease({
    bridge: {
      refreshStarted: () => 5,
      refreshHeartbeat: () => false,
      refreshSettled: () => false,
    },
    mode: "quick",
    onState: (value) => states.push(value),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  await lease.start();
  scheduler.fire(ELECTRON_REFRESH_HEARTBEAT_INTERVAL_MS);
  await new Promise(setImmediate);
  assert.equal(states.at(-1).reason, "heartbeat_failed");
  assert.equal(await lease.finish(), false);
  assert.equal(states.at(-1).state, "recovering");
  assert.equal(states.at(-1).reason, "settlement_failed");
});

test("invalid modes and malformed lease replies fail closed", async () => {
  assert.throws(() => createElectronRefreshLease({ bridge: {}, mode: "full" }), TypeError);
  const states = [];
  const lease = createElectronRefreshLease({
    bridge: { refreshStarted: () => "17" },
    mode: "quick",
    onState: (value) => states.push(value),
  });
  assert.equal(await lease.start(), null);
  assert.equal(states.at(-1).state, "unavailable");
  assert.equal(states.at(-1).reason, "invalid_start_reply");
});
