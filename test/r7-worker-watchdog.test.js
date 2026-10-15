import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import {
  R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_STDERR_BYTES,
  R7_WORKER_MAXIMUM_STDOUT_BYTES,
  R7_WORKER_RSS_SAMPLE_INTERVAL_MS,
  R7_WORKER_WATCHDOG_VERSION,
  runR7WorkerWatchdog,
  sampleDarwinArm64ChildRss,
} from "../src/r7-worker-watchdog.js";

function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function manualScheduler() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    scheduleTimeout(fn, milliseconds) {
      const handle = { fn, milliseconds, cancelled: false };
      timeouts.push(handle);
      return handle;
    },
    cancelTimeout(handle) { handle.cancelled = true; },
    scheduleInterval(fn, milliseconds) {
      const handle = { fn, milliseconds, cancelled: false };
      intervals.push(handle);
      return handle;
    },
    cancelInterval(handle) { handle.cancelled = true; },
    fire(handle) { if (!handle.cancelled) handle.fn(); },
  };
}

function request(extra = {}) {
  return {
    runtimeExecutable: "/synthetic/node",
    workerPath: "/synthetic/worker.js",
    cwd: "/synthetic/cwd",
    input: Buffer.from('{"safe":true}'),
    timeoutMs: 1_000,
    maximumRssBytes: 1024 * 1024,
    ...extra,
  };
}

function dependencies(child, scheduler, extra = {}) {
  return {
    platform: "darwin",
    architecture: "arm64",
    spawnProcess: () => child,
    sampleRss: async () => ({ status: "sampled", rssBytes: 8_192 }),
    monotonicNow: () => 0n,
    scheduleTimeout: scheduler.scheduleTimeout,
    cancelTimeout: scheduler.cancelTimeout,
    scheduleInterval: scheduler.scheduleInterval,
    cancelInterval: scheduler.cancelInterval,
    ...extra,
  };
}

test("watchdog uses fixed argv and an isolated environment and returns aggregates only", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  const privateCanary = "PRIVATE_WATCHDOG_CANARY";
  let consumed = null;
  let spawnCall = null;
  let now = 1_000_000_000n;
  const promise = runR7WorkerWatchdog(request({
    input: privateCanary,
    consumeStdout(bytes) { consumed = bytes.toString("utf8"); },
  }), dependencies(child, scheduler, {
    monotonicNow: () => now,
    spawnProcess(executable, argv, options) {
      spawnCall = { executable, argv, options };
      return child;
    },
    sampleRss: async () => ({ status: "sampled", rssBytes: 12_288 }),
  }));
  child.stdout.write('{"operation":"safe"}');
  child.stderr.write(privateCanary);
  now += 25_000_000n;
  child.emit("close", 0, null);
  const result = await promise;

  assert.deepEqual(spawnCall, {
    executable: "/synthetic/node",
    argv: ["/synthetic/worker.js"],
    options: {
      cwd: "/synthetic/cwd",
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  });
  assert.equal(consumed, '{"operation":"safe"}');
  assert.deepEqual(result, {
    watchdogVersion: R7_WORKER_WATCHDOG_VERSION,
    outcome: "completed",
    termination: "clean",
    elapsedMs: 25,
    peakRssBytes: 12_288,
    rssSampleCount: 1,
    rssSampleFailureCount: 0,
    rssMeasurementStatus: "sampled",
    rssSamplingIntervalMs: R7_WORKER_RSS_SAMPLE_INTERVAL_MS,
    stdoutBytes: 20,
    stderrBytes: Buffer.byteLength(privateCanary),
  });
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.equal(child.stdin.read()?.toString("utf8"), privateCanary);
});

test("timeout checks the monotonic deadline and kills only after it is reached", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  let now = 5_000_000_000n;
  const promise = runR7WorkerWatchdog(request({ timeoutMs: 100 }), dependencies(child, scheduler, {
    monotonicNow: () => now,
  }));
  assert.equal(scheduler.timeouts[0].milliseconds, 100);
  scheduler.fire(scheduler.timeouts[0]);
  assert.deepEqual(child.kills, []);
  assert.equal(scheduler.timeouts[1].milliseconds, 100);

  now += 100_000_000n;
  scheduler.fire(scheduler.timeouts[1]);
  assert.deepEqual(child.kills, ["SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  const result = await promise;
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.termination, "sigkill");
  assert.equal(result.elapsedMs, 100);
});

test("a clean close observed after the monotonic deadline is still a timeout", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  let now = 0n;
  const promise = runR7WorkerWatchdog(request({ timeoutMs: 10 }), dependencies(child, scheduler, {
    monotonicNow: () => now,
  }));
  now = 11_000_000n;
  child.emit("close", 0, null);
  const result = await promise;
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.termination, "clean");
  assert.equal(result.elapsedMs, 11);
});

test("RSS sampling uses the fixed interval and retains only peak/count aggregates", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  const samples = [4_096, 16_384];
  const promise = runR7WorkerWatchdog(request(), dependencies(child, scheduler, {
    sampleRss: async () => ({ status: "sampled", rssBytes: samples.shift() }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.intervals[0].milliseconds, R7_WORKER_RSS_SAMPLE_INTERVAL_MS);
  scheduler.fire(scheduler.intervals[0]);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0, null);
  const result = await promise;
  assert.equal(result.peakRssBytes, 16_384);
  assert.equal(result.rssSampleCount, 2);
  assert.equal(result.rssSampleFailureCount, 0);
  assert.equal("rssSamples" in result, false);
});

test("RSS ceiling accepts the exact threshold and kills at threshold plus one", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  const samples = [100, 101];
  const promise = runR7WorkerWatchdog(request({ maximumRssBytes: 100 }), dependencies(child, scheduler, {
    hardMaximumRssBytes: 100,
    sampleRss: async () => ({ status: "sampled", rssBytes: samples.shift() }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.kills, []);
  scheduler.fire(scheduler.intervals[0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.kills, ["SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  const result = await promise;
  assert.equal(result.outcome, "rss_limit_exceeded");
  assert.equal(result.termination, "sigkill");
  assert.equal(result.peakRssBytes, 101);
  assert.equal(result.rssSampleCount, 2);
});

test("terminal lifetime RSS rejects a clean worker when external sampling misses the peak", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  let consumed = false;
  const promise = runR7WorkerWatchdog(request({
    maximumRssBytes: 100,
    requireLifetimePeakRss: true,
    consumeStdout() {
      consumed = true;
      return 101;
    },
  }), dependencies(child, scheduler, {
    hardMaximumRssBytes: 100,
    sampleRss: async () => ({ status: "sampled", rssBytes: 99 }),
  }));
  child.stdout.write('{"status":"completed","peakRssBytes":101}');
  child.emit("close", 0, null);
  const result = await promise;
  assert.equal(consumed, true);
  assert.equal(result.outcome, "rss_limit_exceeded");
  assert.equal(result.termination, "clean");
  assert.equal(result.peakRssBytes, 99);
  assert.equal(result.rssSampleCount, 1);
  assert.deepEqual(child.kills, []);
});

test("required terminal lifetime RSS fails closed when worker output omits it", async () => {
  for (const returned of [undefined, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const child = fakeChild();
    const scheduler = manualScheduler();
    const promise = runR7WorkerWatchdog(request({
      requireLifetimePeakRss: true,
      consumeStdout() { return returned; },
    }), dependencies(child, scheduler));
    child.stdout.write('{"status":"completed"}');
    child.emit("close", 0, null);
    const result = await promise;
    assert.equal(result.outcome, "stdout_rejected");
    assert.equal(result.termination, "clean");
  }
});

test("an in-flight external RSS sample still rejects a worker that closes cleanly", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  let releaseSample;
  const promise = runR7WorkerWatchdog(request({ maximumRssBytes: 100 }), dependencies(child, scheduler, {
    hardMaximumRssBytes: 100,
    sampleRss: () => new Promise((resolve) => { releaseSample = resolve; }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0, null);
  releaseSample({ status: "sampled", rssBytes: 101 });
  const result = await promise;
  assert.equal(result.outcome, "rss_limit_exceeded");
  assert.equal(result.termination, "clean");
  assert.equal(result.peakRssBytes, 101);
});

test("an in-flight RSS sample that drains after the deadline cannot return completed", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  let now = 0n;
  let releaseSample;
  const promise = runR7WorkerWatchdog(request({ timeoutMs: 10 }), dependencies(child, scheduler, {
    monotonicNow: () => now,
    sampleRss: () => new Promise((resolve) => { releaseSample = resolve; }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  now = 9_000_000n;
  child.emit("close", 0, null);
  now = 11_000_000n;
  releaseSample({ status: "sampled", rssBytes: 99 });
  const result = await promise;
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.termination, "clean");
  assert.equal(result.elapsedMs, 11);
});

test("stdout and stderr limits stop workers with fixed content-free outcomes", async (t) => {
  for (const [streamName, limit, expected] of [
    ["stdout", R7_WORKER_MAXIMUM_STDOUT_BYTES, "stdout_limit_exceeded"],
    ["stderr", R7_WORKER_MAXIMUM_STDERR_BYTES, "stderr_limit_exceeded"],
  ]) {
    await t.test(streamName, async () => {
      const child = fakeChild();
      const scheduler = manualScheduler();
      let consumed = false;
      const promise = runR7WorkerWatchdog(request({
        consumeStdout() { consumed = true; },
      }), dependencies(child, scheduler));
      child[streamName].write(Buffer.alloc(limit + 1, 0x58));
      assert.deepEqual(child.kills, ["SIGKILL"]);
      child.emit("close", null, "SIGKILL");
      const result = await promise;
      assert.equal(result.outcome, expected);
      assert.equal(result[`${streamName}Bytes`], limit + 1);
      assert.equal(consumed, false);
      assert.equal(JSON.stringify(result).includes("X"), false);
    });
  }
});

test("unconfirmed termination has a bounded fixed outcome", async () => {
  const child = fakeChild();
  const scheduler = manualScheduler();
  let now = 0n;
  const promise = runR7WorkerWatchdog(request({ timeoutMs: 10 }), dependencies(child, scheduler, {
    monotonicNow: () => now,
  }));
  now = 10_000_000n;
  scheduler.fire(scheduler.timeouts[0]);
  assert.equal(scheduler.timeouts.length, 2);
  scheduler.fire(scheduler.timeouts[1]);
  const result = await promise;
  assert.equal(result.outcome, "termination_unconfirmed");
  assert.equal(result.termination, "timed_out");
  assert.deepEqual(child.kills, ["SIGKILL", "SIGKILL"]);
});

test("sampler invokes Darwin ps directly with fixed arguments and parses KiB", async () => {
  let call = null;
  const result = await sampleDarwinArm64ChildRss(4321, {
    platform: "darwin",
    architecture: "arm64",
    execFileProcess(executable, argv, options, callback) {
      call = { executable, argv, options };
      callback(null, " 123\n", "");
    },
  });
  assert.deepEqual(result, { status: "sampled", rssBytes: 123 * 1_024 });
  assert.deepEqual(call, {
    executable: "/bin/ps",
    argv: ["-o", "rss=", "-p", "4321"],
    options: {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      maxBuffer: 1_024,
      timeout: 1_000,
      windowsHide: true,
    },
  });
});

test("unsupported platforms and sampling failures remain content-free", async () => {
  let spawned = false;
  const unsupported = await runR7WorkerWatchdog(request(), {
    platform: "linux",
    architecture: "x64",
    monotonicNow: () => 0n,
    spawnProcess() { spawned = true; },
  });
  assert.equal(unsupported.outcome, "unsupported_platform");
  assert.equal(spawned, false);

  const sample = await sampleDarwinArm64ChildRss(55, {
    platform: "darwin",
    architecture: "arm64",
    execFileProcess(_executable, _argv, _options, callback) {
      callback(Object.assign(new Error("PRIVATE_PS_ERROR"), { code: 99 }), "PRIVATE_PS_OUTPUT", "");
    },
  });
  assert.deepEqual(sample, { status: "unavailable", rssBytes: null });
  assert.equal(JSON.stringify(sample).includes("PRIVATE"), false);
});

test("invalid requests fail before spawning and stdout consumer failures are fixed", async () => {
  let spawned = false;
  await assert.rejects(
    runR7WorkerWatchdog(request({ workerPath: "relative-worker.js" }), {
      spawnProcess() { spawned = true; },
    }),
    /workerPath must be an absolute path/,
  );
  assert.equal(spawned, false);

  await assert.rejects(
    runR7WorkerWatchdog(request({
      input: Buffer.alloc(R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES + 1),
    })),
    /selected byte limit/,
  );
  await assert.rejects(
    runR7WorkerWatchdog(request({ maximumStdinBytes: R7_WORKER_MAXIMUM_STDIN_BYTES + 1 })),
    /maximumStdinBytes/,
  );
  await assert.rejects(
    runR7WorkerWatchdog(request({ requireLifetimePeakRss: true, consumeStdout: undefined })),
    /requires consumeStdout/,
  );

  const largeChild = fakeChild();
  const largeScheduler = manualScheduler();
  const largePromise = runR7WorkerWatchdog(request({
    input: Buffer.alloc(R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES + 1),
    maximumStdinBytes: R7_WORKER_MAXIMUM_STDIN_BYTES,
  }), dependencies(largeChild, largeScheduler));
  largeChild.emit("close", 0, null);
  assert.equal((await largePromise).outcome, "completed");

  for (const maximumRssBytes of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      runR7WorkerWatchdog(request({ maximumRssBytes }), {
        platform: "darwin",
        architecture: "arm64",
        hardMaximumRssBytes: 100,
        spawnProcess() { spawned = true; },
      }),
      /maximumRssBytes/,
    );
  }
  await assert.rejects(
    runR7WorkerWatchdog(request({ maximumRssBytes: 101 }), {
      platform: "darwin",
      architecture: "arm64",
      hardMaximumRssBytes: 100,
      spawnProcess() { spawned = true; },
    }),
    /hard maximum/,
  );

  const child = fakeChild();
  const scheduler = manualScheduler();
  const promise = runR7WorkerWatchdog(request({
    consumeStdout() { throw new Error("PRIVATE_CONSUMER_ERROR"); },
  }), dependencies(child, scheduler));
  child.stdout.write("PRIVATE_WORKER_OUTPUT");
  child.emit("close", 0, null);
  const result = await promise;
  assert.equal(result.outcome, "stdout_rejected");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("spawn and worker process failures use fixed content-free classifications", async (t) => {
  await t.test("synchronous spawn failure", async () => {
    const result = await runR7WorkerWatchdog(request(), {
      platform: "darwin",
      architecture: "arm64",
      monotonicNow: () => 0n,
      spawnProcess() { throw new Error("PRIVATE_SYNC_SPAWN_ERROR"); },
    });
    assert.equal(result.outcome, "spawn_failed");
    assert.equal(result.termination, "not_started");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  });

  await t.test("asynchronous child error", async () => {
    const child = fakeChild();
    const scheduler = manualScheduler();
    const promise = runR7WorkerWatchdog(request(), dependencies(child, scheduler));
    child.emit("error", new Error("PRIVATE_ASYNC_SPAWN_ERROR"));
    const result = await promise;
    assert.equal(result.outcome, "spawn_failed");
    assert.equal(result.termination, "spawn_error");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  });

  for (const [name, code, signal, termination] of [
    ["nonzero close", 2, null, "nonzero"],
    ["non-SIGKILL signal", null, "SIGTERM", "signaled"],
  ]) {
    await t.test(name, async () => {
      const child = fakeChild();
      const scheduler = manualScheduler();
      const promise = runR7WorkerWatchdog(request(), dependencies(child, scheduler));
      child.stderr.write("PRIVATE_WORKER_FAILURE");
      child.emit("close", code, signal);
      const result = await promise;
      assert.equal(result.outcome, "worker_failed");
      assert.equal(result.termination, termination);
      assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    });
  }

  await t.test("stdin stream error", async () => {
    const child = fakeChild();
    const scheduler = manualScheduler();
    const promise = runR7WorkerWatchdog(request(), dependencies(child, scheduler));
    child.stdin.emit("error", new Error("PRIVATE_STDIN_ERROR"));
    assert.deepEqual(child.kills, ["SIGKILL"]);
    child.emit("close", null, "SIGKILL");
    const result = await promise;
    assert.equal(result.outcome, "worker_failed");
    assert.equal(result.termination, "sigkill");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  });
});

test("pre-aborted watchdog never spawns or schedules work and discards arbitrary reasons", async () => {
  const controller = new AbortController();
  controller.abort(new Error("PRIVATE_ABORT_REASON"));
  const scheduler = manualScheduler();
  let spawned = false;
  const result = await runR7WorkerWatchdog(request({ signal: controller.signal }),
    dependencies(null, scheduler, { spawnProcess() { spawned = true; } }));
  assert.equal(result.outcome, "aborted");
  assert.equal(result.termination, "not_started");
  assert.equal(spawned, false);
  assert.equal(scheduler.timeouts.length, 0);
  assert.equal(scheduler.intervals.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE_ABORT_REASON"), false);
  await assert.rejects(runR7WorkerWatchdog(request({ signal: {} })), /signal must be an AbortSignal/);
});

test("active abort waits for owned child close and drains RSS before discarding output", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const scheduler = manualScheduler();
  let releaseSample;
  let consumed = false;
  let resolved = false;
  const promise = runR7WorkerWatchdog(request({
    signal: controller.signal,
    consumeStdout() { consumed = true; },
  }), dependencies(child, scheduler, {
    sampleRss: () => new Promise((resolve) => { releaseSample = resolve; }),
  })).then((result) => { resolved = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write("PRIVATE_PARTIAL_OUTPUT");
  controller.abort({ private: "PRIVATE_ABORT_REASON" });
  child.stdout.write("PRIVATE_LATE_OUTPUT");
  assert.deepEqual(child.kills, ["SIGKILL"]);
  assert.equal(resolved, false);
  child.emit("close", null, "SIGKILL");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  releaseSample({ status: "sampled", rssBytes: 42 });
  const result = await promise;
  assert.equal(result.outcome, "aborted");
  assert.equal(result.termination, "sigkill");
  assert.equal(result.peakRssBytes, 42);
  assert.equal(consumed, false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(scheduler.timeouts.every((handle) => handle.cancelled), true);
  assert.equal(scheduler.intervals.every((handle) => handle.cancelled), true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abort during post-close RSS drain cannot consume stdout or report completion", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const scheduler = manualScheduler();
  let releaseSample;
  let consumed = false;
  const promise = runR7WorkerWatchdog(request({
    signal: controller.signal,
    consumeStdout() { consumed = true; },
  }), dependencies(child, scheduler, {
    sampleRss: () => new Promise((resolve) => { releaseSample = resolve; }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write("PRIVATE_COMPLETE_OUTPUT");
  child.emit("close", 0, null);
  controller.abort("PRIVATE_ABORT_REASON");
  releaseSample({ status: "sampled", rssBytes: 42 });
  const result = await promise;
  assert.equal(result.outcome, "aborted");
  assert.equal(result.termination, "clean");
  assert.equal(consumed, false);
  assert.deepEqual(child.kills, []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abort during spawn and synchronous close during kill leave no scheduled handles", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  child.kill = (signal) => { child.kills.push(signal); child.emit("close", null, signal); return true; };
  const scheduler = manualScheduler();
  const result = await runR7WorkerWatchdog(request({ signal: controller.signal }),
    dependencies(child, scheduler, {
      spawnProcess() { controller.abort("PRIVATE_ABORT_REASON"); return child; },
    }));
  assert.equal(result.outcome, "aborted");
  assert.equal(result.termination, "sigkill");
  assert.deepEqual(child.kills, ["SIGKILL"]);
  assert.equal(scheduler.timeouts.every((handle) => handle.cancelled), true);
  assert.equal(scheduler.intervals.length, 0);
  assert.equal(child.stdin.read(), null);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("unconfirmed abort preserves its fixed classification and removes owned listeners", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const scheduler = manualScheduler();
  const promise = runR7WorkerWatchdog(request({ signal: controller.signal }), dependencies(child, scheduler));
  controller.abort("PRIVATE_ABORT_REASON");
  scheduler.fire(scheduler.timeouts.at(-1));
  const result = await promise;
  assert.equal(result.outcome, "termination_unconfirmed");
  assert.equal(result.termination, "aborted");
  assert.deepEqual(child.kills, ["SIGKILL", "SIGKILL"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(scheduler.timeouts.every((handle) => handle.cancelled), true);
  assert.equal(scheduler.intervals.every((handle) => handle.cancelled), true);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("normal completion removes its abort listener without terminating the child", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const scheduler = manualScheduler();
  const promise = runR7WorkerWatchdog(request({ signal: controller.signal }), dependencies(child, scheduler));
  child.emit("close", 0, null);
  assert.equal((await promise).outcome, "completed");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  assert.deepEqual(child.kills, []);
  assert.equal(scheduler.timeouts.every((handle) => handle.cancelled), true);
  assert.equal(scheduler.intervals.every((handle) => handle.cancelled), true);
});

test("real node:test timeout cancels and closes its owned watchdog worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "r7-watchdog-cancellation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerPath = join(root, "worker.mjs");
  const testPath = join(root, "timeout.test.mjs");
  await writeFile(workerPath, "setInterval(() => {}, 1_000);\n", { mode: 0o600 });
  await writeFile(testPath, `
import test from "node:test";
import { spawn } from "node:child_process";
import { runR7WorkerWatchdog } from ${JSON.stringify(new URL("../src/r7-worker-watchdog.js", import.meta.url).href)};
let ownedChild;
process.once("SIGTERM", () => { ownedChild?.kill("SIGKILL"); process.exitCode = 1; });
test("synthetic timeout", { timeout: 30 }, async (t) => {
  let child;
  const result = await runR7WorkerWatchdog({
    runtimeExecutable: process.execPath,
    workerPath: ${JSON.stringify(workerPath)},
    cwd: ${JSON.stringify(root)},
    input: "{}",
    maximumRssBytes: 1024 * 1024,
    signal: t.signal,
  }, {
    platform: "darwin",
    architecture: "arm64",
    spawnProcess(...args) { child = spawn(...args); ownedChild = child; return child; },
    sampleRss: async () => ({ status: "sampled", rssBytes: 1 }),
  });
  console.log("CANCELLATION_RESULT=" + JSON.stringify({
    outcome: result.outcome,
    termination: result.termination,
    closed: child.signalCode === "SIGKILL",
  }));
});
`, { mode: 0o600 });
  let failure;
  try {
    await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap", testPath], {
      timeout: 5_000,
      maxBuffer: 32 * 1024,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, 1);
  assert.equal(failure.killed, false);
  assert.match(failure.stdout, /testTimeoutFailure/);
  assert.match(failure.stdout, /CANCELLATION_RESULT=\{"outcome":"aborted","termination":"sigkill","closed":true\}/);
});

test("abort from a synchronous stdout consumer cannot yield a completed outcome", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const scheduler = manualScheduler();
  const promise = runR7WorkerWatchdog(request({
    signal: controller.signal,
    consumeStdout() { controller.abort("PRIVATE_ABORT_REASON"); },
  }), dependencies(child, scheduler));
  child.stdout.write("synthetic");
  child.emit("close", 0, null);
  const result = await promise;
  assert.equal(result.outcome, "aborted");
  assert.equal(result.termination, "clean");
  assert.deepEqual(child.kills, []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
