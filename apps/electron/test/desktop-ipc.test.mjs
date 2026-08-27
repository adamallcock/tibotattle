import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  DESKTOP_IPC_CHANNEL,
} from "../desktop-contract.js";
import {
  createDesktopIpcHandler,
  installDesktopIpc,
} from "../desktop-ipc.js";

function errorCode(code) {
  return (error) => {
    assert.equal(error?.name, "DesktopIpcError");
    assert.equal(error?.code, code);
    assert.equal(error?.message, "Desktop IPC request rejected");
    return true;
  };
}

test("desktop IPC dispatches only the exact action envelope after sender/frame authorization", async () => {
  const trustedSender = {};
  const trustedFrame = {};
  const calls = [];
  const handler = createDesktopIpcHandler({
    trustedSender: (sender) => sender === trustedSender,
    trustedFrame: (frame) => frame === trustedFrame,
    handlers: {
      setLanguage(args, context) {
        calls.push({ args, context });
        return { ok: true };
      },
    },
  });
  const event = { sender: trustedSender, senderFrame: trustedFrame };
  assert.deepEqual(
    await handler(event, { action: "setLanguage", args: { value: "en" } }),
    { ok: true },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { value: "en" });
  assert.equal(calls[0].context.sender, trustedSender);
  assert.equal(calls[0].context.senderFrame, trustedFrame);
});
test("desktop IPC fails closed for an untrusted sender or frame before handlers run", async () => {
  const trustedSender = {};
  const trustedFrame = {};
  let calls = 0;
  const handler = createDesktopIpcHandler({
    trustedSender,
    trustedFrame,
    handlers: { getSettings() { calls += 1; } },
  });
  for (const event of [
    { sender: {}, senderFrame: trustedFrame },
    { sender: trustedSender, senderFrame: {} },
    { sender: {}, senderFrame: {} },
    {},
  ]) {
    await assert.rejects(
      handler(event, { action: "getSettings", args: {} }),
      errorCode("desktop_ipc_untrusted_context"),
    );
  }
  assert.equal(calls, 0);
});

test("desktop IPC restricts dashboard-owned actions to the active dashboard frame", async () => {
  const dashboardSender = {};
  const dashboardFrame = {};
  const settingsSender = {};
  const settingsFrame = {};
  const calls = [];
  const handler = createDesktopIpcHandler({
    trustedSender: (sender) => sender === dashboardSender || sender === settingsSender,
    trustedFrame: (frame) => frame === dashboardFrame || frame === settingsFrame,
    trustedAction: (action, event) => (
      action !== "refreshStarted"
      && action !== "refreshSettled"
      && action !== "toggleSidebar"
    ) || (event.sender === dashboardSender && event.senderFrame === dashboardFrame),
    handlers: {
      refreshStarted() {
        calls.push("started");
        return 1;
      },
      refreshSettled() {
        calls.push("settled");
        return true;
      },
      toggleSidebar() {
        calls.push("sidebar");
        return true;
      },
    },
  });

  await assert.rejects(
    handler(
      { sender: settingsSender, senderFrame: settingsFrame },
      { action: "refreshStarted", args: {} },
    ),
    errorCode("desktop_ipc_untrusted_context"),
  );
  await assert.rejects(
    handler(
      { sender: settingsSender, senderFrame: settingsFrame },
      { action: "toggleSidebar", args: {} },
    ),
    errorCode("desktop_ipc_untrusted_context"),
  );
  assert.deepEqual(
    await handler(
      { sender: dashboardSender, senderFrame: dashboardFrame },
      { action: "refreshStarted", args: {} },
    ),
    1,
  );
  assert.deepEqual(
    await handler(
      { sender: dashboardSender, senderFrame: dashboardFrame },
      { action: "refreshSettled", args: { lease: 1 } },
    ),
    true,
  );
  assert.deepEqual(
    await handler(
      { sender: dashboardSender, senderFrame: dashboardFrame },
      { action: "toggleSidebar", args: {} },
    ),
    true,
  );
  assert.deepEqual(calls, ["started", "settled", "sidebar"]);
});

test("desktop IPC rejects malformed and extra request keys without invoking a handler", async () => {
  const sender = {};
  const frame = {};
  let calls = 0;
  const handler = createDesktopIpcHandler({
    trustedSender: sender,
    trustedFrame: frame,
    handlers: { getSettings() { calls += 1; } },
  });
  const event = { sender, senderFrame: frame };
  for (const request of [
    { action: "getSettings", args: { extra: true } },
    { action: "getSettings", args: {}, extra: true },
    { action: "not-allowed", args: {} },
    { action: "setLanguage", args: { value: "fr" } },
    { action: "getSettings", args: [] },
    null,
  ]) {
    await assert.rejects(
      handler(event, request),
      errorCode("desktop_ipc_invalid_request"),
    );
  }
  assert.equal(calls, 0);
});

test("desktop IPC does not expose an unbounded handler and normalizes failures", async () => {
  const sender = {};
  const frame = {};
  const handler = createDesktopIpcHandler({
    trustedSender: sender,
    trustedFrame: frame,
    handlers: {
      getSettings() {
        throw new Error("private detail must not cross the boundary");
      },
    },
  });
  await assert.rejects(
    handler({ sender, senderFrame: frame }, { action: "getSettings", args: {} }),
    errorCode("desktop_ipc_handler_failed"),
  );
  assert.throws(
    () => createDesktopIpcHandler({
      trustedSender: sender,
      trustedFrame: frame,
      handlers: { arbitrary() {} },
    }),
    /unknown action/u,
  );
});

test("desktop IPC installs exactly one fixed Electron channel and disposes it", () => {
  const ipcMain = new EventEmitter();
  const registrations = [];
  const removals = [];
  ipcMain.handle = (channel, handler) => registrations.push({ channel, handler });
  ipcMain.removeHandler = (channel) => removals.push(channel);
  const sender = {};
  const frame = {};
  const installed = installDesktopIpc({
    ipcMain,
    trustedSender: sender,
    trustedFrame: frame,
    handlers: { getSettings() {} },
  });
  assert.equal(installed.channel, DESKTOP_IPC_CHANNEL);
  assert.deepEqual(registrations.map(({ channel }) => channel), [DESKTOP_IPC_CHANNEL]);
  assert.equal(typeof installed.handler, "function");
  installed.dispose();
  installed.dispose();
  assert.deepEqual(removals, [DESKTOP_IPC_CHANNEL]);
});
