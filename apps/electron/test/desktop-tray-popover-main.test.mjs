import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesktopTrayPopover,
  createDesktopTrayPopoverModel,
  installDesktopTrayPopoverPolicy,
  TRAY_POPOVER_ACTION_CHANNEL,
  TRAY_POPOVER_MODEL_CHANNEL,
  TRAY_POPOVER_VISIBILITY_CHANNEL,
  TRAY_POPOVER_CONTENT_HEIGHT_CHANNEL,
} from "../desktop-tray-popover.js";

const POPOVER_ORIGIN = "http://127.0.0.1:54321";
const POPOVER_PAGE_URL = `${POPOVER_ORIGIN}/electron-tray-popup.html`;

const EVIDENCE = Object.freeze({
  schemaVersion: "tibotattle-notification-evidence-v2",
  status: "fresh_provider_observation",
  provider: "openai_codex",
  source: "app_server_read",
  freshness: "fresh",
  observedAt: "2026-08-22T12:00:00.000Z",
  continuityKey: "a".repeat(43),
  windows: Object.freeze([
    Object.freeze({
      lane: "primary",
      usedPercent: 26,
      durationMinutes: 300,
      resetAt: "2026-08-22T15:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }),
    Object.freeze({
      lane: "secondary",
      usedPercent: 44,
      durationMinutes: 10_080,
      resetAt: "2026-08-29T12:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }),
  ]),
});

function status(state = "fresh") {
  return {
    status: state,
    allowance: state === "fresh"
      ? { source: "direct", window: "five_hour", remainingPercent: 74 }
      : null,
    notificationEvidence: state === "fresh" ? EVIDENCE : null,
  };
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.session = {};
    this.sent = [];
    this.windowOpenHandler = null;
    this.mainFrame = { isMainFrame: true, parent: null };
    this.currentURL = "";
  }

  send(channel, value) { this.sent.push({ channel, value }); }
  getURL() { return this.currentURL; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.loaded = [];
    this.visible = false;
    this.destroyed = false;
    this.positions = [];
    this.sizes = [];
    this.showCalls = 0;
    this.focusCalls = 0;
    this.showInactiveCalls = 0;
  }

  loadURL(url) {
    this.loaded.push(url);
    this.webContents.currentURL = url;
    return Promise.resolve();
  }
  getSize() { return [this.options.width, this.options.height]; }
  setSize(width, height) {
    this.sizes.push([width, height]);
    this.options.width = width;
    this.options.height = height;
  }
  setPosition(x, y) { this.positions.push([x, y]); }
  show() { this.showCalls += 1; this.visible = true; }
  focus() { this.focusCalls += 1; }
  showInactive() { this.showInactiveCalls += 1; this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
}

async function preloadFixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-tray-popover-"));
  const path = join(root, "tray-popover-preload.cjs");
  await writeFile(path, "// synthetic tray preload\n");
  return path;
}

test("popover model is a content-free projection of direct tray evidence", () => {
  const model = createDesktopTrayPopoverModel({
    appName: "TiboTattle Dev",
    trayStatus: status(),
    locale: "en-US",
    now: Date.parse("2026-08-22T12:04:00.000Z"),
  });
  assert.deepEqual(Object.keys(model), [
    "version",
    "appName",
    "status",
    "statusLabel",
    "evidenceLabel",
    "compactTitle",
    "windows",
    "refreshEnabled",
    "hint",
  ]);
  assert.equal(model.compactTitle, "74%");
  assert.equal(model.windows.length, 2);
  assert.equal(model.windows[0].remainingPercent, 74);
  assert.equal(model.windows[1].remainingPercent, 56);
  assert.equal(JSON.stringify(model).includes("continuityKey"), false);
  assert.equal(JSON.stringify(model).includes("app_server_read"), false);
  assert.equal(JSON.stringify(model).includes("/private"), false);
});

test("popover requires the exact local shared renderer route", async () => {
  const preloadPath = await preloadFixture();
  const model = createDesktopTrayPopoverModel({
    appName: "TiboTattle Dev",
    trayStatus: status(),
    locale: "en-US",
    now: Date.parse("2026-08-22T12:04:00.000Z"),
  });
  assert.throws(() => createDesktopTrayPopover({
    BrowserWindow: FakeWindow,
    preloadPath,
    model,
    onAction: () => {},
  }), /page URL is invalid/u);
  assert.throws(() => createDesktopTrayPopover({
    BrowserWindow: FakeWindow,
    preloadPath,
    pageURL: "https://example.invalid/electron-tray-popup.html",
    origin: POPOVER_ORIGIN,
    model,
    onAction: () => {},
  }), /page URL is invalid/u);
});

test("popover policy accepts only top-frame fixed actions and blocks navigation", () => {
  const webContents = new FakeWebContents();
  const calls = [];
  const initialURL = "data:text/html;charset=utf-8,initial";
  webContents.currentURL = initialURL;
  const policy = installDesktopTrayPopoverPolicy({
    webContents,
    initialURL,
    onAction: (value) => calls.push(value),
  });
  const preventions = [];
  webContents.emit("ipc-message", {
    sender: webContents,
    senderFrame: webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "weekly");
  webContents.emit("ipc-message", {
    sender: webContents,
    senderFrame: { isMainFrame: false, parent: webContents.mainFrame },
  }, TRAY_POPOVER_ACTION_CHANNEL, "quit");
  webContents.emit("ipc-message", {
    sender: {},
    senderFrame: webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "quit");
  webContents.emit("ipc-message", {
    sender: webContents,
    senderFrame: webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "accounting");
  webContents.emit("ipc-message", {
    sender: webContents,
    senderFrame: webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "unexpected");
  webContents.emit("ipc-message", {
    sender: webContents,
  }, TRAY_POPOVER_ACTION_CHANNEL, "quit");
  webContents.currentURL = "https://example.invalid/";
  webContents.emit("ipc-message", {
    sender: webContents,
    senderFrame: webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "quit");
  webContents.currentURL = initialURL;
  webContents.emit("will-navigate", {
    preventDefault: () => preventions.push("navigate"),
  }, "https://example.invalid");
  webContents.emit("will-frame-navigate", {
    preventDefault: () => preventions.push("frame"),
  }, { isMainFrame: false, url: "data:text/html;charset=utf-8,initial" });
  assert.deepEqual(calls, ["weekly", "accounting"]);
  assert.deepEqual(preventions, ["navigate", "frame"]);
  assert.deepEqual(webContents.windowOpenHandler?.(), { action: "deny" });
  policy.remove();
  webContents.emit("ipc-message", {
    sender: webContents,
    senderFrame: webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "timeline");
  assert.deepEqual(calls, ["weekly", "accounting"]);
});

test("popover controller lazily positions, updates, routes, and destroys a trusted window", async () => {
  const preloadPath = await preloadFixture();
  const windows = [];
  const actions = [];
  const tray = { getBounds: () => ({ x: 400, y: 20, width: 24, height: 24 }) };
  const popover = createDesktopTrayPopover({
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    preloadPath,
    pageURL: POPOVER_PAGE_URL,
    origin: POPOVER_ORIGIN,
    tray,
    platform: "darwin",
    model: createDesktopTrayPopoverModel({ trayStatus: status("unavailable") }),
    onAction: (value) => actions.push(value),
  });
  assert.equal(windows.length, 0);
  assert.equal(popover.available, true);
  assert.equal(popover.show(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const window = windows[0];
  assert.equal(window.options.frame, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.height, 500);
  assert.equal(window.options.minWidth, 1);
  assert.equal(window.options.maxWidth, 400);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.loaded.length, 1);
  assert.equal(window.loaded[0], POPOVER_PAGE_URL);
  assert.equal(window.showCalls, 1);
  assert.equal(window.focusCalls, 1);
  assert.equal(window.showInactiveCalls, 0);
  assert.equal(window.webContents.sent[0].channel, TRAY_POPOVER_MODEL_CHANNEL,
    "first presentation seeds controls before publishing visibility");
  assert.equal(window.webContents.sent[0].value.refreshEnabled, true);
  assert.deepEqual(
    window.webContents.sent
      .filter(({ channel }) => channel === TRAY_POPOVER_VISIBILITY_CHANNEL)
      .map(({ value }) => value),
    [true],
  );
  assert.deepEqual(window.positions, [[212, 52]]);
  assert.equal(popover.visible, true);

  const nextModel = createDesktopTrayPopoverModel({ trayStatus: status() });
  assert.equal(popover.setModel(nextModel), true);
  assert.equal(window.webContents.sent.at(-1).channel, TRAY_POPOVER_MODEL_CHANNEL);
  assert.equal(window.webContents.sent.at(-1).value.compactTitle, "74%");
  window.webContents.emit("ipc-message", {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "weekly");
  assert.deepEqual(actions, ["weekly"]);
  assert.equal(popover.visible, false);
  assert.equal(window.webContents.sent.at(-1).channel, TRAY_POPOVER_VISIBILITY_CHANNEL);
  assert.equal(window.webContents.sent.at(-1).value, false);
  assert.equal(popover.toggle(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(popover.visible, true);
  assert.equal(window.webContents.sent.at(-1).channel, TRAY_POPOVER_VISIBILITY_CHANNEL);
  assert.equal(window.webContents.sent.at(-1).value, true);
  assert.equal(window.webContents.sent.at(-2).channel, TRAY_POPOVER_MODEL_CHANNEL);
  assert.equal(window.webContents.sent.at(-2).value.compactTitle, "74%",
    "reopening republishes the latest model without waiting for a quota change");
  popover.destroy();
  assert.equal(popover.visible, false);
  assert.equal(popover.available, false);
  assert.equal(popover.setModel(nextModel), false);
});

test("a failed initial load is discarded so reopening retries the route", async () => {
  for (const failure of ["reject", "throw"]) {
    const preloadPath = await preloadFixture();
    const windows = [];
    let attempts = 0;
    class RetryWindow extends FakeWindow {
      loadURL(url) {
        this.loaded.push(url);
        this.webContents.currentURL = url;
        attempts += 1;
        if (attempts === 1 && failure === "throw") {
          throw new Error("synthetic load failure");
        }
        if (attempts === 1) return Promise.reject(new Error("synthetic load failure"));
        return Promise.resolve();
      }
    }
    const popover = createDesktopTrayPopover({
      BrowserWindow: class extends RetryWindow {
        constructor(options) {
          super(options);
          windows.push(this);
        }
      },
      preloadPath,
      pageURL: POPOVER_PAGE_URL,
      origin: POPOVER_ORIGIN,
      platform: "darwin",
      model: createDesktopTrayPopoverModel({ trayStatus: status("unavailable") }),
      onAction: () => {},
    });
    assert.equal(popover.show(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts, 1);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].destroyed, true);
    assert.equal(popover.visible, false);

    assert.equal(popover.show(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts, 2);
    assert.equal(windows.length, 2);
    assert.deepEqual(windows[1].loaded, [POPOVER_PAGE_URL]);
    assert.equal(popover.visible, true);
    popover.destroy();
  }
});

test("content height fits the popup without reopening it and restores after a small display", async () => {
  const preloadPath = await preloadFixture();
  const windows = [];
  let area = { x: 0, y: 24, width: 1200, height: 900 };
  const popover = createDesktopTrayPopover({
    BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); windows.push(this); }
    },
    preloadPath,
    pageURL: POPOVER_PAGE_URL,
    origin: POPOVER_ORIGIN,
    tray: { getBounds: () => ({ x: 500, y: 0, width: 40, height: 24 }) },
    screen: { getDisplayMatching: () => ({ workArea: area }) },
    platform: "darwin",
    onAction: () => {},
  });
  popover.show();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const window = windows[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const report = (...values) => window.webContents.emit(
    "ipc-message", event, TRAY_POPOVER_CONTENT_HEIGHT_CHANNEL, ...values,
  );
  report(476);
  assert.deepEqual(window.getSize(), [400, 476]);
  assert.equal(window.showCalls, 1, "layout changes never show or focus the window again");
  assert.equal(window.focusCalls, 1);
  for (const value of [0, -1, 4097, 476.5, "600", NaN, Infinity, {}]) report(value);
  report(600, "extra");
  window.webContents.emit("ipc-message", { ...event, senderFrame: {} },
    TRAY_POPOVER_CONTENT_HEIGHT_CHANNEL, 600);
  window.webContents.emit("ipc-message", { ...event, sender: {} },
    TRAY_POPOVER_CONTENT_HEIGHT_CHANNEL, 600);
  assert.deepEqual(window.getSize(), [400, 476]);
  popover.hide();
  report(590);
  assert.equal(window.visible, false);
  assert.equal(window.showCalls, 1);
  area = { x: -300, y: 0, width: 300, height: 300 };
  popover.show();
  assert.deepEqual(window.getSize(), [276, 276]);
  area = { x: 0, y: 24, width: 1200, height: 900 };
  popover.show();
  assert.deepEqual(window.getSize(), [400, 590], "the natural size survives the work-area cap");
  report(4096);
  assert.deepEqual(window.getSize(), [400, 720]);
  report(1);
  assert.deepEqual(window.getSize(), [400, 240]);
  window.webContents.currentURL = "http://127.0.0.1:54321/other";
  report(590);
  assert.deepEqual(window.getSize(), [400, 240], "a navigated frame cannot resize the popup");
  popover.destroy();
});

test("popover accepts negative display origins, caps to work area, and dismisses on Escape", async () => {
  const preloadPath = await preloadFixture();
  const windows = [];
  const trayBounds = { x: -1_400, y: -500, width: 24, height: 24 };
  const tray = { getBounds: () => trayBounds };
  const screen = {
    getDisplayMatching: (bounds) => {
      assert.deepEqual(bounds, trayBounds);
      return { workArea: { x: -1_440, y: -900, width: 1_920, height: 460 } };
    },
  };
  const popover = createDesktopTrayPopover({
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    preloadPath,
    pageURL: POPOVER_PAGE_URL,
    origin: POPOVER_ORIGIN,
    tray,
    screen,
    platform: "win32",
    model: createDesktopTrayPopoverModel({ trayStatus: status("unavailable") }),
    onAction: () => {},
  });
  assert.equal(popover.show(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const window = windows[0];
  assert.deepEqual(window.sizes, [[400, 436]]);
  const [x, y] = window.positions.at(-1);
  assert.ok(x >= -1_440 && x + 400 <= 480, `x=${x}`);
  assert.ok(y >= -900 && y + 436 <= -440, `y=${y}`);
  assert.equal(popover.visible, true);
  window.webContents.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
  assert.equal(popover.visible, false);
});
