import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DEPLOYMENT_ENDPOINTS } from "../../config/deployment-endpoints.js";
import { createLocalAccountlessContribution } from "./accountless-contribution.js";
import { attachAccountlessParentChannel } from "../../src/platform/index.js";

const origin = "http://127.0.0.1:18765";
test("companion accountless mode is absent without an explicit mode and private channel", () => {
  assert.equal(createLocalAccountlessContribution({ environment: {} }), null);
  for (const environment of [
    { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin },
    { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://tibotattle.com", USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" },
    { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin, USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1", USAGE_MONITOR_CENTRAL_ORIGIN: "https://tibotattle.com" },
  ]) assert.throws(() => createLocalAccountlessContribution({ environment }), /Invalid accountless contribution configuration/u);
});

for (const mode of ["laboratory", "production"]) test(`${mode} companion composes saved preference, private credential port and one bounded runner`, async () => {
  const origin = mode === "laboratory" ? "http://127.0.0.1:18765" : "https://tibotattle.com";
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (value, cb) => queueMicrotask(() => { to.emit("message", structuredClone(value)); cb?.(); });
  }
  let enabled = true;
  let calls = 0;
  const host = attachAccountlessParentChannel({ channel: parent, backend: {}, readPreference: async () => ({
    available: true, current: true, enabled, policyVersion: "accountless-opt-out-v1", destinationOrigin: origin,
  }) });
  const selected = createLocalAccountlessContribution({
    environment: { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin,
      ...(mode === "laboratory" ? { USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" }
        : { USAGE_MONITOR_ACCOUNTLESS_MODE: "production-v1" }) },
    stateRoot: "/synthetic", indexFile: "/synthetic/index.sqlite", channel: child,
    schedulerOptions: { setTimer: () => 1, clearTimer: () => {} },
    runner: async (options) => {
      calls++;
      assert.equal(options.laboratory, mode === "laboratory");
      assert.equal(options.production, mode === "production");
      assert.equal(Object.hasOwn(options, "rehearsal"), false);
      assert.equal(options.origin, origin);
      assert.equal(options.indexFile, "/synthetic/index.sqlite");
      assert.equal(options.stateFile, "/synthetic/accountless-device-binding-v1.json");
      assert.equal((await options.readPreference()).enabled, true);
      assert.ok(options.signal instanceof AbortSignal);
      return { status: "complete", chunksUploaded: 1 };
    },
  });
  selected.start();
  await selected.runNow();
  assert.equal(calls, 1);
  enabled = false;
  host.invalidate();
  await new Promise((resolve) => setImmediate(resolve));
  await selected.runNow();
  assert.equal(calls, 1);
  assert.equal(selected.inspect().state, "off");
  await selected.stop();
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("disconnect"), 0);
  host.dispose();
});

test("companion detaches its private channel even if scheduler cleanup fails", async () => {
  const child = new EventEmitter();
  child.connected = true;
  child.send = () => {};
  const selected = createLocalAccountlessContribution({
    environment: { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: origin, USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" },
    stateRoot: "/synthetic", indexFile: "/synthetic/index.sqlite", channel: child,
    schedulerOptions: { setTimer: () => 1, clearTimer: () => { throw new Error("synthetic timer failure"); } },
  });
  selected.start();
  await assert.rejects(selected.stop(), /synthetic timer failure/u);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("disconnect"), 0);
});


test("production companion refuses ambient modes without the private parent capability", () => {
  const base = { USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://tibotattle.com",
    USAGE_MONITOR_ACCOUNTLESS_MODE: "production-v1" };
  for (const environment of [base, { ...base, USAGE_MONITOR_TEST_LANE: "macos-electron-local-qa-v1" },
    { ...base, USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://unreviewed.example" },
    { ...base, USAGE_MONITOR_ACCOUNTLESS_ORIGIN: DEPLOYMENT_ENDPOINTS.staging.origin },
    { USAGE_MONITOR_ACCOUNTLESS_MODE: "rehearsal-v1",
      USAGE_MONITOR_ACCOUNTLESS_ORIGIN: DEPLOYMENT_ENDPOINTS.staging.origin }]) {
    assert.throws(() => createLocalAccountlessContribution({ environment, channel: {} }),
      /Invalid accountless contribution configuration/u);
  }
});
