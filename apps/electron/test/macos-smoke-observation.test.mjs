import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  installMacosSmokeObservation,
  MACOS_ELECTRON_LOCAL_QA_TEST_LANE,
} from "../main.js";

const ENVIRONMENT = Object.freeze({
  USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1",
  USAGE_MONITOR_TEST_LANE: MACOS_ELECTRON_LOCAL_QA_TEST_LANE,
});
const OBSERVE = "tibotattle-macos-smoke-observe-v1";

function source({ connected = true, send = () => {} } = {}) {
  const value = new EventEmitter();
  value.connected = connected;
  value.send = send;
  return value;
}

test("macOS smoke observation is a strictly gated, fixed-shape parent IPC response", () => {
  const sent = [];
  const messageSource = source({
    send(message, callback) {
      sent.push(message);
      callback?.();
    },
  });
  const lifecycle = {
    state: {
      windowVisible: true,
      settingsWindowVisible: false,
      ignored: "/private/path",
    },
  };
  const cleanup = installMacosSmokeObservation(lifecycle, {
    platform: "darwin",
    environment: ENVIRONMENT,
    messageSource,
  });
  assert.equal(messageSource.listenerCount("message"), 1);
  assert.equal(messageSource.listenerCount("disconnect"), 1);

  messageSource.emit("message", { type: OBSERVE, extra: true });
  messageSource.emit("message", { type: "other-v1" });
  messageSource.emit("message", OBSERVE);
  assert.deepEqual(sent, []);

  messageSource.emit("message", { type: OBSERVE });
  assert.equal(sent.length, 1);
  assert.equal(Object.isFrozen(sent[0]), true);
  assert.deepEqual(sent[0], {
    type: "tibotattle-macos-smoke-state-v1",
    windowVisible: true,
    settingsWindowVisible: false,
  });
  assert.deepEqual(Object.keys(sent[0]), [
    "type",
    "windowVisible",
    "settingsWindowVisible",
  ]);

  lifecycle.state.windowVisible = false;
  lifecycle.state.settingsWindowVisible = true;
  messageSource.emit("message", { type: OBSERVE });
  assert.deepEqual(sent.at(-1), {
    type: "tibotattle-macos-smoke-state-v1",
    windowVisible: false,
    settingsWindowVisible: true,
  });

  messageSource.emit("disconnect");
  assert.equal(messageSource.listenerCount("message"), 0);
  assert.equal(messageSource.listenerCount("disconnect"), 0);
  messageSource.emit("message", { type: OBSERVE });
  assert.equal(sent.length, 2);
  cleanup();
});

test("macOS smoke observation is absent without every exact gate and live Node IPC", () => {
  const lifecycle = { state: { windowVisible: true, settingsWindowVisible: true } };
  const cases = [
    { platform: "win32", environment: ENVIRONMENT, connected: true, hasSend: true },
    { platform: "darwin", environment: {}, connected: true, hasSend: true },
    {
      platform: "darwin",
      environment: {
        ...ENVIRONMENT,
        USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "other-v1",
      },
      connected: true,
      hasSend: true,
    },
    { platform: "darwin", environment: ENVIRONMENT, connected: false, hasSend: true },
    { platform: "darwin", environment: ENVIRONMENT, connected: true, hasSend: false },
  ];
  for (const value of cases) {
    const sent = [];
    const messageSource = source({
      connected: value.connected,
      send: (message) => sent.push(message),
    });
    if (!value.hasSend) messageSource.send = undefined;
    const cleanup = installMacosSmokeObservation(lifecycle, {
      platform: value.platform,
      environment: value.environment,
      messageSource,
    });
    assert.equal(messageSource.listenerCount("message"), 0, JSON.stringify(value));
    messageSource.emit("message", { type: OBSERVE });
    assert.deepEqual(sent, [], JSON.stringify(value));
    cleanup();
  }
});
