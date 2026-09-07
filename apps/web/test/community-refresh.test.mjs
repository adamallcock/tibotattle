import assert from "node:assert/strict";
import test from "node:test";
import { createCommunityRefresh } from "../public/community-refresh.js";

const settled = () => new Promise(resolve => setImmediate(resolve));
function harness(replies = []) {
  let clock = 0, sequence = 0, visible = true;
  const timers = new Map(), calls = [], publications = [];
  const refresh = createCommunityRefresh({
    now: () => clock, visible: () => visible,
    schedule: (fn, delay) => { const id = ++sequence; timers.set(id, { at: clock + delay, fn }); return id; },
    cancel: id => timers.delete(id),
    read: options => { calls.push(options); return (replies.shift() ?? (() => ({ version: calls.length })))(options); },
    publish: result => publications.push(result),
  });
  return {
    refresh, calls, publications, timers,
    visible(value) { visible = value; refresh.visibilityChanged(); },
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at; timers.delete(next[0]); void next[1].fn(); await settled();
      }
      clock = end; await settled();
    },
  };
}

test("refreshes automatically without overlapping requests or wiping a publication on network failure", async () => {
  const h = harness([() => ({ allowanceState: "ready", version: 1 }), () => { throw new Error("offline"); },
    () => ({ allowanceState: "ready", version: 2 })]);
  h.refresh.start(); h.refresh.start(); await settled();
  assert.equal(h.calls.length, 1); assert.equal(h.publications.length, 1);
  await h.advance(60_000);
  assert.equal(h.calls.length, 2); assert.equal(h.publications.length, 1);
  await h.advance(119_999); assert.equal(h.calls.length, 2);
  await h.advance(1); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.publications.at(-1), { payload: { allowanceState: "ready", version: 2 }, failure: null });
  h.refresh.stop(); assert.equal(h.timers.size, 0);
});

test("authoritative invalidation replaces the old graph, including publication-disabled refusals", async () => {
  const paused = Object.assign(new Error("disabled"), { code: "PUBLICATION_DISABLED", status: 503 });
  const h = harness([() => ({ allowanceState: "ready" }), () => ({ allowanceState: "updating", days: [] }),
    () => { throw paused; }]);
  h.refresh.start(); await settled(); await h.advance(60_000);
  assert.deepEqual(h.publications.at(-1), { payload: { allowanceState: "updating", days: [] }, failure: null });
  await h.advance(60_000);
  assert.deepEqual(h.publications.at(-1), { payload: null, failure: paused });
  h.refresh.stop();
});

test("hidden tabs stop polling; returning refreshes with a cooldown against rapid visibility changes", async () => {
  const h = harness(); h.refresh.start(); await settled();
  h.visible(false); await h.advance(600_000); assert.equal(h.calls.length, 1);
  h.visible(true); await settled(); assert.equal(h.calls.length, 2);
  for (let i = 0; i < 20; i++) { h.visible(false); h.visible(true); }
  await h.advance(14_999); assert.equal(h.calls.length, 2);
  await h.advance(1); assert.equal(h.calls.length, 3);
  h.refresh.stop();
});

test("times out a stalled request and retries with bounded backoff without overlap", async () => {
  const h = harness([() => new Promise(() => {})]);
  h.refresh.start(); await settled();
  h.visible(true); assert.equal(h.calls.length, 1);
  await h.advance(15_000);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.publications[0].payload, null);
  assert.equal(h.publications[0].failure.message, "Community refresh timed out.");
  await h.advance(119_999); assert.equal(h.calls.length, 1);
  await h.advance(1); assert.equal(h.calls.length, 2);
  h.refresh.stop();
});

test("late completions from a stopped page cannot overwrite a restored page", async () => {
  let finish;
  const h = harness([() => new Promise(resolve => { finish = resolve; })]);
  h.refresh.start(); await settled(); h.refresh.stop(); h.refresh.start();
  finish({ obsolete: true }); await settled();
  assert.equal(h.publications.length, 0);
  await h.advance(15_000);
  assert.deepEqual(h.publications, [{ payload: { version: 2 }, failure: null }]);
  h.refresh.stop();
});

test("repeated outages back off to the five-minute ceiling", async () => {
  const fail = () => { throw new Error("offline"); };
  const h = harness(Array.from({ length: 10 }, () => fail));
  h.refresh.start(); await settled();
  for (const delay of [120_000, 240_000, 300_000, 300_000]) {
    const count = h.calls.length;
    await h.advance(delay - 1); assert.equal(h.calls.length, count);
    await h.advance(1); assert.equal(h.calls.length, count + 1);
  }
  h.refresh.stop();
});
