import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopStatusMonitor,
  DESKTOP_STATUS_DEFAULT_MAX_BODY_BYTES,
  DESKTOP_STATUS_PATH,
} from "../desktop-status-monitor.js";
import {
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
} from "../../../src/desktop-shell-status.js";

const ORIGIN = "http://127.0.0.1:43127";
const URL = `${ORIGIN}${DESKTOP_STATUS_PATH}`;
const STARTING = Object.freeze({
  schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  state: "starting",
  allowance: null,
  notificationEvidence: null,
});
const UNAVAILABLE = Object.freeze({
  schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  state: "unavailable",
  allowance: null,
  notificationEvidence: null,
});

function response(body, {
  status = 200,
  contentType = "application/json; charset=utf-8",
  responseURL = URL,
  redirected = false,
  stream = false,
} = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  const headers = new Map([
    ["content-type", contentType],
    ["content-length", String(bytes.byteLength)],
  ]);
  const result = {
    status,
    url: responseURL,
    redirected,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
  };
  if (stream) {
    let used = false;
    result.body = {
      getReader() {
        assert.equal(used, false);
        used = true;
        return {
          async read() {
            if (used === "done") return { done: true };
            used = "done";
            return { done: false, value: bytes };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    };
  } else {
    result.body = null;
    result.text = async () => text;
  }
  return result;
}

class FakeAbortController {
  constructor() {
    this.signal = { aborted: false };
    FakeAbortController.instances.push(this);
  }

  abort() {
    this.signal.aborted = true;
    this.aborted = true;
  }
}

FakeAbortController.instances = [];

function timerHarness() {
  const timers = [];
  const setTimeoutImpl = (callback, delay) => {
    const timer = {
      callback,
      delay,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
      cleared: false,
    };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutImpl = (timer) => { timer.cleared = true; };
  return {
    timers,
    setTimeoutImpl,
    clearTimeoutImpl,
    async runNext() {
      const timer = timers.find((candidate) => !candidate.cleared);
      assert.ok(timer, "expected an active timer");
      timer.cleared = true;
      await timer.callback();
      return timer;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function neverResolvingStreamResponse(activeReaders, cancelledReaders) {
  const candidate = response(STARTING, { stream: true });
  candidate.body = {
    getReader() {
      const reader = {
        read: () => new Promise(() => {}),
        cancel() {
          cancelledReaders.push(reader);
          activeReaders.delete(reader);
        },
        releaseLock() {},
      };
      activeReaders.add(reader);
      return reader;
    },
  };
  return candidate;
}

function neverResolvingTextResponse(cancelledBodies) {
  const candidate = response(STARTING);
  candidate.body = {
    cancel() {
      cancelledBodies.push(candidate.body);
    },
  };
  candidate.text = () => new Promise(() => {});
  return candidate;
}

function activeTimerWithDelay(timers, delay) {
  const timer = timers.find((candidate) => !candidate.cleared
    && candidate.delay === delay);
  assert.ok(timer, `expected an active ${delay}ms timer`);
  return timer;
}

class EventedFakeAbortController extends FakeAbortController {
  constructor() {
    super();
    const listeners = new Set();
    this.signal.addEventListener = (_type, listener) => {
      listeners.add(listener);
    };
    this.signal.removeEventListener = (_type, listener) => {
      listeners.delete(listener);
    };
    this.abort = () => {
      if (this.signal.aborted) return;
      super.abort();
      for (const listener of listeners) listener();
      listeners.clear();
    };
  }
}

function monitorFixture(fetchImpl, options = {}) {
  const timers = timerHarness();
  const statuses = [];
  const monitor = createDesktopStatusMonitor({
    fetchImpl,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    AbortControllerImpl: FakeAbortController,
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  return { monitor, statuses, timers };
}

test("start validates one exact loopback origin and polls only the fixed route", async () => {
  const calls = [];
  const fixture = monitorFixture(async (url, init) => {
    calls.push({ url, init });
    return response(STARTING);
  });
  assert.deepEqual(fixture.monitor.start(ORIGIN), { origin: ORIGIN });
  assert.deepEqual(fixture.statuses, [STARTING]);
  await fixture.monitor.pollNow();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.signal.aborted, false);
  assert.equal(Object.isFrozen(fixture.statuses[0]), true);
  fixture.monitor.stop();
});

test("rejects localhost, non-loopback, URL decoration, and arbitrary path input", () => {
  const fixture = monitorFixture(async () => response(STARTING));
  for (const origin of [
    "http://localhost:43127",
    "http://127.0.0.1",
    "http://127.0.0.2:43127",
    "https://127.0.0.1:43127",
    "http://127.0.0.1:43127/",
    "http://127.0.0.1:43127?x=1",
    "http://127.0.0.1:43127#x",
    "http://user:pass@127.0.0.1:43127",
    "http://127.0.0.1:43127/api/local/health",
  ]) {
    assert.throws(() => fixture.monitor.start(origin), TypeError);
  }
});

test("malformed, redirected, non-JSON, non-200, and oversized responses become unavailable", async () => {
  const cases = [
    response(STARTING, { responseURL: `${ORIGIN}/other` }),
    response(STARTING, { redirected: true }),
    response(STARTING, { contentType: "text/html" }),
    response(STARTING, { status: 500 }),
    response("{"),
    response({ ...STARTING, extra: "secret" }),
    response("x".repeat(20), { contentType: "application/json" }),
  ];
  for (const candidate of cases) {
    const fixture = monitorFixture(async () => candidate, { maxBodyBytes: 19 });
    fixture.monitor.start(ORIGIN);
    const result = await fixture.monitor.pollNow();
    assert.deepEqual(result, UNAVAILABLE);
    assert.deepEqual(fixture.statuses.at(-1), UNAVAILABLE);
    fixture.monitor.stop();
  }
});

test("bounds streamed bodies and rejects invalid stream chunks", async () => {
  const fixture = monitorFixture(async () => response(STARTING, { stream: true }), {
    maxBodyBytes: 512,
  });
  fixture.monitor.start(ORIGIN);
  assert.deepEqual(await fixture.monitor.pollNow(), STARTING);
  fixture.monitor.stop();

  const tooLarge = monitorFixture(async () => response("x".repeat(40), {
    stream: true,
  }), { maxBodyBytes: 32 });
  tooLarge.monitor.start(ORIGIN);
  assert.deepEqual(await tooLarge.monitor.pollNow(), UNAVAILABLE);
  tooLarge.monitor.stop();

  const invalidChunk = monitorFixture(async () => ({
    status: 200,
    url: URL,
    headers: { get: () => "application/json" },
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: "not bytes" }),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  }));
  invalidChunk.monitor.start(ORIGIN);
  assert.deepEqual(await invalidChunk.monitor.pollNow(), UNAVAILABLE);
  invalidChunk.monitor.stop();
});

test("fetch exceptions and callback exceptions never expose raw errors", async () => {
  const seen = [];
  const timers = timerHarness();
  const monitor = createDesktopStatusMonitor({
    fetchImpl: async () => { throw new Error("/private/raw-secret"); },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    AbortControllerImpl: FakeAbortController,
    onStatus: (status) => {
      seen.push(status);
      if (status.state === "unavailable") throw new Error("observer failure");
    },
  });
  monitor.start(ORIGIN);
  await assert.doesNotReject(monitor.pollNow());
  assert.equal(seen.at(-1).state, "unavailable");
  assert.equal(JSON.stringify(seen.at(-1)).includes("raw-secret"), false);
  monitor.stop();
});

test("deduplicates concurrent polls and unrefs timers", async () => {
  let resolveFetch;
  let calls = 0;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const fixture = monitorFixture(() => {
    calls += 1;
    return fetchPromise;
  });
  fixture.monitor.start(ORIGIN);
  const first = fixture.monitor.pollNow();
  const second = fixture.monitor.pollNow();
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(fixture.timers.timers.every((timer) => timer.unrefCalled), true);
  resolveFetch(response(STARTING));
  assert.deepEqual(await first, STARTING);
  fixture.monitor.stop();
});

test("hard timeout settles a signal-aware fetch, clears in-flight state, and reschedules", async () => {
  let calls = 0;
  const fixture = monitorFixture((_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }, {
    AbortControllerImpl: EventedFakeAbortController,
    timeoutMs: 25,
  });
  fixture.monitor.start(ORIGIN);
  const firstPoll = fixture.monitor.pollNow();
  await flushMicrotasks();

  // Drain the start() tick first so the timeout's reschedule is observable.
  await fixture.timers.runNext();
  await fixture.timers.runNext();
  assert.deepEqual(await firstPoll, UNAVAILABLE);
  assert.deepEqual(fixture.statuses.at(-1), UNAVAILABLE);
  assert.equal(FakeAbortController.instances.at(-1).signal.aborted, true);
  assert.ok(activeTimerWithDelay(fixture.timers.timers, 5_000));

  // The hard timeout has released the monitor even though the underlying
  // promise's rejection is delivered on a later microtask.
  const replacementPoll = fixture.monitor.pollNow();
  assert.notEqual(replacementPoll, firstPoll);
  assert.equal(calls, 2);
  fixture.monitor.stop();
  assert.equal(await replacementPoll, null);
  assert.deepEqual(fixture.statuses, [STARTING, UNAVAILABLE]);
});

test("hard timeout bounds a non-cooperative response body and ignores its late completion", async () => {
  let releaseBody;
  const fixture = monitorFixture(async () => {
    const candidate = response(STARTING);
    candidate.text = () => new Promise((resolve) => {
      releaseBody = resolve;
    });
    return candidate;
  }, { timeoutMs: 25 });
  fixture.monitor.start(ORIGIN);
  const poll = fixture.monitor.pollNow();
  await flushMicrotasks();
  assert.equal(typeof releaseBody, "function");

  await fixture.timers.runNext();
  await fixture.timers.runNext();
  assert.deepEqual(await poll, UNAVAILABLE);
  assert.deepEqual(fixture.statuses, [STARTING, UNAVAILABLE]);

  releaseBody(JSON.stringify(STARTING));
  await flushMicrotasks();
  assert.deepEqual(fixture.statuses, [STARTING, UNAVAILABLE]);
  fixture.monitor.stop();
});

test("cancels a non-cooperative stream reader and caps retries while it remains pending", async () => {
  const activeReaders = new Set();
  const cancelledReaders = [];
  let fetchCalls = 0;
  const fixture = monitorFixture(async () => {
    fetchCalls += 1;
    return neverResolvingStreamResponse(activeReaders, cancelledReaders);
  }, { timeoutMs: 25 });
  fixture.monitor.start(ORIGIN);
  const firstPoll = fixture.monitor.pollNow();
  await flushMicrotasks();
  assert.equal(activeReaders.size, 1);

  // Drain the start() tick first, then fire the body timeout.
  await fixture.timers.runNext();
  await fixture.timers.runNext();
  assert.deepEqual(await firstPoll, UNAVAILABLE);
  assert.equal(cancelledReaders.length, 1);
  assert.equal(activeReaders.size, 0);

  // A cancelled body that ignores cancellation must not permit a new body
  // reader on every retry. The monitor remains bounded and unavailable.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.deepEqual(await fixture.monitor.pollNow(), UNAVAILABLE);
    assert.equal(fetchCalls, 1);
    assert.equal(activeReaders.size, 0);
  }
  fixture.monitor.stop();
});

test("cancels a non-cooperative text body on stop and ignores its late completion", async () => {
  const cancelledBodies = [];
  let fetchCalls = 0;
  const fixture = monitorFixture(async () => {
    fetchCalls += 1;
    return neverResolvingTextResponse(cancelledBodies);
  });
  fixture.monitor.start(ORIGIN);
  const poll = fixture.monitor.pollNow();
  await flushMicrotasks();
  fixture.monitor.stop();
  assert.equal(await poll, null);
  assert.equal(fetchCalls, 1);
  assert.equal(cancelledBodies.length, 1);

  // The unresolved text() promise cannot deliver a stale status after stop.
  await flushMicrotasks();
  assert.equal(cancelledBodies.length, 1);
});

test("stop and restart abort old work and never deliver a stale response", async () => {
  FakeAbortController.instances.length = 0;
  const resolvers = [];
  const fixture = monitorFixture(() => new Promise((resolve) => {
    resolvers.push(resolve);
  }));
  fixture.monitor.start(ORIGIN);
  const oldPoll = fixture.monitor.pollNow();
  fixture.monitor.stop();
  fixture.monitor.start(ORIGIN);
  const newPoll = fixture.monitor.pollNow();
  assert.equal(FakeAbortController.instances.at(-2).aborted, true);
  resolvers[0](response({
    ...STARTING,
    state: "unavailable",
  }));
  assert.equal(await oldPoll, null);
  assert.deepEqual(fixture.statuses, [STARTING, STARTING]);
  resolvers[1](response(STARTING));
  assert.deepEqual(await newPoll, STARTING);
  assert.deepEqual(fixture.statuses.at(-1), STARTING);
  fixture.monitor.stop();
});

test("stop clears scheduled work and does not fetch while inactive", async () => {
  let calls = 0;
  const fixture = monitorFixture(async () => {
    calls += 1;
    return response(STARTING);
  });
  fixture.monitor.start(ORIGIN);
  fixture.monitor.stop();
  await fixture.timers.runNext().catch(() => {});
  await fixture.monitor.pollNow();
  assert.equal(calls, 0);
  assert.equal(fixture.statuses.length, 1);
});

test("configuration bounds and fixed body ceiling are enforced", () => {
  for (const options of [
    { intervalMs: 0 },
    { intervalMs: 60_001 },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { maxBodyBytes: 0 },
    { maxBodyBytes: 256 * 1024 + 1 },
    { extra: true },
  ]) {
    assert.throws(() => createDesktopStatusMonitor(options), TypeError);
  }
  assert.equal(DESKTOP_STATUS_DEFAULT_MAX_BODY_BYTES <= 256 * 1024, true);
});
