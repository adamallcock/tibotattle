import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

import {
  TRAY_POPOVER_ACTION_CHANNEL,
  TRAY_POPOVER_MODEL_CHANNEL,
  TRAY_POPOVER_VISIBILITY_CHANNEL,
  TRAY_POPOVER_CONTENT_HEIGHT_CHANNEL,
} from "../desktop-tray-popover.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PRELOAD_PATH = resolve(REPOSITORY_ROOT, "apps/electron/tray-popover-preload.cjs");

test("tray popup preload exposes immutable actions and main-owned visibility", async () => {
  const exposed = [];
  const listeners = new Map();
  const sent = [];
  const ipcRenderer = {
    on(channel, listener) {
      const current = listeners.get(channel) ?? [];
      current.push(listener);
      listeners.set(channel, current);
    },
    removeListener(channel, listener) {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((item) => item !== listener));
    },
    send(channel, ...values) {
      sent.push({ channel, values });
    },
  };
  const context = {
    require(specifier) {
      assert.equal(specifier, "electron");
      return { contextBridge: {
        exposeInMainWorld(name, value) {
          exposed.push({ name, value });
        },
      }, ipcRenderer };
    },
  };
  const source = await readFile(PRELOAD_PATH, "utf8");
  vm.runInNewContext(source, context, { filename: PRELOAD_PATH });
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, "tibotattleTrayPopover");
  const bridge = exposed[0].value;
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal(bridge.version, "v1");
  assert.equal(bridge.getVisibility(), false);

  const unsubscribeModel = bridge.onModel(() => {});
  assert.equal(typeof unsubscribeModel, "function");
  assert.equal((listeners.get(TRAY_POPOVER_MODEL_CHANNEL) ?? []).length, 1);
  unsubscribeModel();

  const received = [];
  const unsubscribe = bridge.onVisibility((value) => received.push(value));
  assert.equal(typeof unsubscribe, "function");
  bridge.requestAction("open");
  assert.deepEqual(sent, [{
    channel: TRAY_POPOVER_ACTION_CHANNEL,
    values: ["open"],
  }]);
  bridge.requestAction("more");
  bridge.requestAction("arbitrary-command");
  assert.deepEqual(sent.at(-1), {
    channel: TRAY_POPOVER_ACTION_CHANNEL,
    values: ["more"],
  });
  assert.equal(sent.length, 2);

  bridge.reportContentHeight(476);
  assert.deepEqual(sent.at(-1), {
    channel: TRAY_POPOVER_CONTENT_HEIGHT_CHANNEL,
    values: [476],
  });
  for (const height of [0, -1, 4097, 476.5, "476", NaN, Infinity, {}]) {
    bridge.reportContentHeight(height);
  }
  assert.equal(sent.length, 3, "only a bounded integer content height leaves the preload");

  for (const listener of listeners.get(TRAY_POPOVER_VISIBILITY_CHANNEL) ?? []) {
    listener({}, true);
  }
  assert.equal(bridge.getVisibility(), true);
  assert.deepEqual(received, [true]);
  for (const listener of listeners.get(TRAY_POPOVER_VISIBILITY_CHANNEL) ?? []) {
    listener({}, true);
  }
  assert.deepEqual(received, [true],
    "native show and explicit visibility publication represent one transition");
  for (const listener of listeners.get(TRAY_POPOVER_VISIBILITY_CHANNEL) ?? []) {
    listener({}, "true");
  }
  assert.equal(bridge.getVisibility(), true);
  assert.deepEqual(received, [true]);
  unsubscribe();
  for (const listener of listeners.get(TRAY_POPOVER_VISIBILITY_CHANNEL) ?? []) {
    listener({}, false);
  }
  assert.equal(bridge.getVisibility(), false);
  assert.deepEqual(received, [true]);

});
