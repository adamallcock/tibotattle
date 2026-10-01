import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTelemetryPerformanceClient,
  createTelemetryPerformanceDayRunner,
  createTelemetryPerformanceScheduler,
} from "../src/application/index.js";

const source = {
  sourceGeneration: "timing:4:2",
  sourceDigest: "a".repeat(64),
  sourceRevision: 6,
  parserVersion: "codex-log-scan-v9",
  rows: [{
    at: Date.parse("2026-09-20T12:00:00.000Z"),
    model: "gpt-5.6-luna",
    provider: "openai_codex",
    effort: "high",
    sample_method: "receipt",
    sample_tokens: 100,
    sample_duration: 1_000,
    sample_responses: 1,
    sample_total_responses: 1,
    ttft: 400,
    turn_duration: 2_000,
    speed_mode: "standard",
    speed_mode_source: "rollout_thread_settings",
  }],
};

test("day runner projects content-free source facts and preserves independent sync state", async () => {
  const calls = [];
  const states = [];
  const runner = createTelemetryPerformanceDayRunner({
    readRows: async request => {
      calls.push(["readRows", request]);
      return source;
    },
    readState: async () => ({
      schemaVersion: "telemetry-performance-sync-state-v1",
      cursorDay: null,
      lastAttemptAt: null,
      lastOutcome: null,
      nextAttemptAt: null,
      paused: false,
      pausedReason: null,
      retryCount: 0,
      lastReportRevision: null,
    }),
    saveState: async state => states.push(state),
    readCapabilities: async () => ({ accepted: true }),
    createEnvelope: async ({ report }) => ({ report }),
    send: async () => ({ status: 202 }),
    sync: async options => {
      const report = await options.prepareDay({ day: options.day });
      calls.push(["sync", report]);
      const next = {
        schemaVersion: "telemetry-performance-sync-state-v1",
        cursorDay: options.day,
        lastAttemptAt: "2026-09-21T12:00:00.000Z",
        lastOutcome: { at: "2026-09-21T12:00:00.000Z", code: "accepted", status: "succeeded" },
        nextAttemptAt: null,
        paused: false,
        pausedReason: null,
        retryCount: 0,
        lastReportRevision: "b".repeat(64),
      };
      await options.saveState(next);
      return { status: "succeeded", state: next, reportRevision: next.lastReportRevision };
    },
    now: () => Date.parse("2026-09-21T12:00:00.000Z"),
  });
  const result = await runner({ day: "2026-09-20", nowEpoch: Date.parse("2026-09-21T12:00:00.000Z") });
  assert.equal(result.status, "succeeded");
  assert.equal(calls[0][0], "readRows");
  assert.equal(calls[1][0], "sync");
  assert.equal(calls[1][1].records.length, 1);
  assert.equal(calls[1][1].records[0].turns, 1);
  assert.equal(calls[1][1].sourceGeneration, source.sourceGeneration);
  assert.equal(states.length, 1);
});

test("scheduler is independently opt-in and does not invoke its caller before start", async () => {
  const calls = [];
  let nextTimer = null;
  const scheduler = createTelemetryPerformanceScheduler({
    runner: async () => {
      calls.push("run");
      return { status: "succeeded" };
    },
    now: () => Date.parse("2026-09-21T12:00:00.000Z"),
    setTimer: (callback, delay) => {
      nextTimer = { callback, delay };
      return nextTimer;
    },
    clearTimer: timer => { if (timer === nextTimer) nextTimer = null; },
    intervalMilliseconds: 60_000,
    retryMilliseconds: 30_000,
    backfillDays: 1,
  });
  assert.equal(scheduler.inspect().state, "off");
  assert.deepEqual(calls, []);
  scheduler.start();
  assert.equal(nextTimer.delay, 0);
  await nextTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["run"]);
  assert.equal(scheduler.inspect().state, "up_to_date");
  await scheduler.stop();
  assert.equal(scheduler.inspect().state, "off");
});

test("scheduler revisits a bounded completed-day window for late corrections", async () => {
  const calls = [];
  let nextTimer = null;
  const scheduler = createTelemetryPerformanceScheduler({
    runner: async ({ day }) => {
      calls.push(day);
      return { status: "succeeded" };
    },
    now: () => Date.parse("2026-09-21T12:00:00.000Z"),
    setTimer: (callback, delay) => {
      nextTimer = { callback, delay };
      return nextTimer;
    },
    clearTimer: timer => { if (timer === nextTimer) nextTimer = null; },
    intervalMilliseconds: 60_000,
    retryMilliseconds: 30_000,
    backfillDays: 3,
  });
  scheduler.start();
  await nextTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["2026-09-20", "2026-09-19", "2026-09-18"]);
  await scheduler.stop();
});

test("scheduler can include the current day as a replaceable report", async () => {
  const calls = [];
  let nextTimer = null;
  const scheduler = createTelemetryPerformanceScheduler({
    runner: async ({ day }) => {
      calls.push(day);
      return { status: "succeeded" };
    },
    now: () => Date.parse("2026-09-21T12:00:00.000Z"),
    setTimer: (callback, delay) => {
      nextTimer = { callback, delay };
      return nextTimer;
    },
    clearTimer: timer => { if (timer === nextTimer) nextTimer = null; },
    intervalMilliseconds: 60_000,
    retryMilliseconds: 30_000,
    backfillDays: 2,
    includeCurrentDay: true,
  });
  scheduler.start();
  await nextTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["2026-09-21", "2026-09-20", "2026-09-19"]);
  await scheduler.stop();
});

test("production client uses only the independent capability and encrypted report routes", async () => {
  const requests = [];
  const client = createTelemetryPerformanceClient({
    origin: "https://telemetry.example.test",
    readAuthorization: async () => "Device synthetic-performance-token",
    readPreparedDay: async ({ day }) => ({ day, reportRevision: "a".repeat(64) }),
    createEnvelope: async ({ report }) => ({ schemaVersion: "telemetry-performance-envelope-v1", report }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.method === "GET") return new Response(JSON.stringify({ accepted: true }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
      return new Response(null, { status: 202 });
    },
    sync: async options => {
      const capability = await options.readCapabilities();
      const report = await options.prepareDay({ day: "2026-09-20" });
      const envelope = await options.createEnvelope({ report, authorization: capability.authorization });
      const response = await options.send({ envelope, report, authorization: capability.authorization });
      return { status: response.status === 202 ? "succeeded" : "retry", capability, report };
    },
  });
  const result = await client.runDay({ day: "2026-09-20", nowEpoch: Date.parse("2026-09-21T12:00:00.000Z") });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(requests.map(request => [request.init.method, new URL(request.url).pathname]), [
    ["GET", "/api/v1/device/telemetry/performance/capabilities"],
    ["POST", "/api/v1/device/telemetry/performance/reports"],
  ]);
  assert.equal(requests[1].init.headers.authorization, "Device synthetic-performance-token");
});


test("performance client bounds capability bodies and distinguishes gateway failures from invalid receipts", async () => {
  for (const kind of ["gateway", "io", "utf8", "oversize", "redirect", "401", "403", "404", "422"]) {
    let cancelled = false;
    const client = createTelemetryPerformanceClient({
      origin: "https://telemetry.example.test", readAuthorization: async () => "Device synthetic-token",
      readPreparedDay: async () => assert.fail("capability must fail first"), createEnvelope: async () => {},
      fetchImpl: async (_, request) => {
        assert.equal(request.redirect, "error");
        assert.equal(request.credentials, "omit");
        const response = new Response(new ReadableStream({
          start(controller) {
            if (kind === "io") controller.error(new Error("synthetic-private-network-error"));
            else {
              controller.enqueue(kind === "utf8" ? Uint8Array.of(0xff) : new TextEncoder().encode(
                kind === "oversize" ? "x".repeat(16_385) : "<html>synthetic gateway</html>"));
            }
          },
          cancel() { cancelled = true; },
        }), { status: kind === "gateway" ? 503 : ["401", "403", "404", "422"].includes(kind) ? Number(kind) : 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "120" } });
        if (kind === "redirect") Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
      sync: async (options) => options.readCapabilities(),
    });
    await assert.rejects(client.runDay(), (error) => {
      assert.equal(error.code, `telemetry_performance_${["gateway", "io"].includes(kind) ? "capability_unavailable"
        : ["401", "403"].includes(kind) ? "authorization_rejected" : "response_invalid"}`, kind);
      if (kind === "gateway") assert.equal(error.retryAfter, "120");
      return true;
    });
    if (kind !== "io") assert.equal(cancelled, true);
  }
});

test("performance scheduler respects the persisted next attempt time", async () => {
  let timer;
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const scheduler = createTelemetryPerformanceScheduler({
    runner: async () => ({ status: "retry", state: { nextAttemptAt: new Date(now + 600_000).toISOString() } }),
    now: () => now, setTimer: (callback, delay) => (timer = { callback, delay }), clearTimer: () => {},
    retryMilliseconds: 30_000,
  });
  scheduler.start();
  await scheduler.runNow();
  assert.equal(timer.delay, 600_000);
  assert.equal(scheduler.inspect().nextAttemptAt, new Date(now + 600_000).toISOString());
  await scheduler.stop();
});


test("performance retry timer clamps distant and past persisted timestamps", async () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  for (const [nextAttemptAt, expected] of [["9999-01-01T00:00:00.000Z", 604_800_000],
    ["2020-01-01T00:00:00.000Z", 30_000], ["invalid", 30_000]]) {
    let delay;
    const scheduler = createTelemetryPerformanceScheduler({
      runner: async () => ({ status: "retry", state: { nextAttemptAt } }), now: () => now,
      setTimer: (_, value) => { delay = value; return 1; }, clearTimer: () => {}, retryMilliseconds: 30_000,
    });
    scheduler.start();
    await scheduler.runNow();
    assert.equal(delay, expected);
    await scheduler.stop();
  }
});
