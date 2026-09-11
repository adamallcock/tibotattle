import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWindowsNormalCandidateQuitControl } from "../main.js";

const REQUEST = Object.freeze({ type: "tibotattle-electron-smoke-quit-v1" });
const ENVIRONMENT = Object.freeze({ USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(overrides = {}) {
  const source = new EventEmitter();
  source.connected = true;
  const sent = [];
  source.send = (message, callback) => { sent.push({ message, callback }); return true; };
  let quits = 0;
  const lifecycle = { state: { primaryInstance: true }, requestQuit: async () => { quits += 1; } };
  const cleanup = installWindowsNormalCandidateQuitControl(lifecycle, {
    platform: "win32", environment: ENVIRONMENT, messageSource: source, ...overrides,
  });
  return { source, sent, lifecycle, cleanup, quits: () => quits };
}

test("normal Windows quit control flushes one fixed acknowledgement before actual lifecycle shutdown", async () => {
  const value = fixture();
  for (const message of [null, [], {}, { ...REQUEST, command: "credential-read-v1" },
    { type: "windows-electron-smoke-v1" }, { ...REQUEST, [Symbol("extra")]: true }]) {
    value.source.emit("message", message);
  }
  assert.equal(value.sent.length, 0);
  value.source.emit("message", REQUEST);
  value.source.emit("message", REQUEST);
  assert.equal(value.sent.length, 1);
  assert.deepEqual(value.sent[0].message, { type: "tibotattle-electron-smoke-quit-accepted-v1" });
  assert.equal(value.quits(), 0);
  value.sent[0].callback();
  value.sent[0].callback();
  await tick();
  assert.equal(value.quits(), 1);
  assert.equal(value.source.listenerCount("message"), 0);
  assert.equal(value.source.listenerCount("disconnect"), 0);
  value.cleanup();
});

test("normal Windows quit control refuses qualification lanes, other platforms and unavailable parent pipes", () => {
  for (const overrides of [
    { platform: "darwin" }, { platform: "linux" }, { environment: {} },
    { environment: { USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1" } },
    { environment: { ...ENVIRONMENT, USAGE_MONITOR_TEST_LANE: "" } },
    { environment: { ...ENVIRONMENT, USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "" } },
    { messageSource: Object.assign(new EventEmitter(), { connected: false, send() {} }) },
  ]) {
    const value = fixture(overrides);
    value.source.emit("message", REQUEST);
    assert.equal(value.quits(), 0);
    assert.equal(value.sent.length, 0);
    value.cleanup();
  }
  const source = Object.assign(new EventEmitter(), { connected: true, send() {} });
  installWindowsNormalCandidateQuitControl({ state: { primaryInstance: false }, requestQuit() {} }, {
    platform: "win32", environment: ENVIRONMENT, messageSource: source,
  });
  assert.equal(source.listenerCount("message"), 0);
});

test("normal Windows quit control does not claim shutdown after lost acknowledgement or disconnect", async () => {
  const failed = fixture();
  failed.source.emit("message", REQUEST);
  failed.sent[0].callback(new Error("synthetic closed pipe"));
  failed.sent[0].callback();
  await tick();
  assert.equal(failed.quits(), 0);
  const disconnected = fixture();
  disconnected.source.emit("disconnect");
  disconnected.source.emit("message", REQUEST);
  assert.equal(disconnected.sent.length, 0);
  assert.equal(disconnected.source.listenerCount("message"), 0);
  const throwing = fixture();
  throwing.source.send = () => { throw new Error("synthetic send failure"); };
  throwing.source.emit("message", REQUEST);
  assert.equal(throwing.quits(), 0);
});

test("normal Windows quit control reports lifecycle teardown failure through its fixed failure callback", async () => {
  let failures = 0;
  const value = fixture({ onFailure: () => { failures += 1; } });
  value.lifecycle.requestQuit = async () => { throw new Error("synthetic teardown failure"); };
  value.source.emit("message", REQUEST);
  value.sent[0].callback();
  await tick();
  assert.equal(failures, 1);
});
