import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDesktopLifecycle } from "../desktop-lifecycle.js";
import { TRAY_POPOVER_ACTION_CHANNEL } from "../desktop-tray-popover.js";

const EVIDENCE = Object.freeze({
  schemaVersion: "tibotattle-notification-evidence-v2",
  status: "fresh_provider_observation",
  provider: "openai_codex",
  source: "app_server_read",
  freshness: "fresh",
  observedAt: "2026-08-22T12:00:00.000Z",
  continuityKey: "a".repeat(43),
  windows: Object.freeze([Object.freeze({
    lane: "primary",
    usedPercent: 26,
    durationMinutes: 300,
    resetAt: "2026-08-22T15:00:00.000Z",
    resetProofKind: "provider_reported_schedule_only",
  })]),
});

function status(state = "fresh", {
  allowance = state === "fresh"
    ? { source: "direct", window: "five_hour", remainingPercent: 74 }
    : null,
  notificationEvidence = state === "fresh" ? EVIDENCE : null,
} = {}) {
  return {
    schemaVersion: "tibotattle-desktop-shell-status-v1",
    state,
    allowance,
    notificationEvidence,
  };
}

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.quitCalls = 0;
  }

  requestSingleInstanceLock() { return true; }
  async whenReady() {}
  quit() { this.quitCalls += 1; }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = { isMainFrame: true, parent: null };
    this.session = {};
  }
  getURL() { return this.url; }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
  }

  loadURL(url) { this.url = url; this.webContents.url = url; return Promise.resolve(); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

class FakeTray extends EventEmitter {
  constructor(icon) {
    super();
    this.initialIcon = icon;
    this.images = [];
    this.menu = null;
    this.titles = [];
  }

  setToolTip() {}
  setContextMenu(menu) { this.menu = menu; }
  setImage(value) { this.images.push(value); }
  setTitle(value) { this.titles.push(value); }
  destroy() {}
}

function fixture({
  fetchImpl,
  onDesktopStatus,
  createTrayIcon,
  platform = "darwin",
  visualTray = false,
} = {}) {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const menus = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) { this.exitHandler = handler; },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4800 + this.starts}` };
    },
    async stop() { this.stops += 1; },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        if (visualTray) {
          this.presentedMenus = [];
          this.popUpContextMenu = (menu) => {
            menu.emit("menu-will-show");
            this.presentedMenus.push(menu);
          };
          this.closeContextMenu = () => {};
        }
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => {
      const menu = Object.assign(new EventEmitter(), { template });
      menus.push(menu);
      return menu;
    } },
    icon: "test-icon",
    createTrayIcon,
    preloadPath: visualTray
      ? fileURLToPath(new URL("../preload.cjs", import.meta.url))
      : "/private/preload.cjs",
    supervisor,
    createNavigationPolicy: () => ({}),
    installNavigationPolicy: () => ({ remove() {} }),
    onDesktopStatus,
    platform,
    desktopStatusMonitorOptions: {
      fetchImpl,
      intervalMs: 60_000,
      timeoutMs: 60_000,
    },
  });
  return { app, lifecycle, supervisor, windows, trays, menus };
}

function jsonResponse(value, url) {
  return {
    status: 200,
    url,
    redirected: false,
    headers: { get: (name) => name === "content-type" ? "application/json" : null },
    text: async () => JSON.stringify(value),
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition did not settle");
}

test("lifecycle projects monitor status into a dynamic localized tray and observer seam", async () => {
  const observed = [];
  const requested = [];
  const fixtureValue = fixture({
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse(status(), url);
    },
    onDesktopStatus: (value) => observed.push(value),
  });

  await fixtureValue.lifecycle.start();
  const tray = fixtureValue.trays[0];
  assert.equal(tray.menu.template[1].label, "Starting");
  await waitFor(() => tray.menu.template[0].label === "TiboTattle · 74% allowance");
  assert.equal(requested[0], "http://127.0.0.1:4801/api/local/desktop-status");
  assert.equal(tray.menu.template[0].label, "TiboTattle · 74% allowance");
  assert.match(tray.menu.template[1].label, /^Observed /u);
  assert.match(tray.menu.template[2].label, /^Five-hour allowance: 74% remaining/u);
  assert.equal(tray.titles.at(-1), "74%");
  assert.deepEqual(observed.map((value) => value.state), ["starting", "fresh"]);
  assert.equal(JSON.stringify(observed).includes("/private"), false);

  assert.equal(fixtureValue.lifecycle.setDesktopLanguage("zh-Hans"), true);
  assert.equal(tray.menu.template[0].label, "TiboTattle · 剩余 74%");
  await fixtureValue.lifecycle.dispose();
});

test("lifecycle forwards a current analyzing overview allowance without notification evidence", async () => {
  const observed = [];
  const fixtureValue = fixture({
    fetchImpl: async (url) => jsonResponse(status("analyzing", {
      allowance: { source: "direct", window: "seven_day", remainingPercent: 0 },
      notificationEvidence: null,
    }), url),
    onDesktopStatus: (value) => observed.push(value),
  });

  await fixtureValue.lifecycle.start();
  const tray = fixtureValue.trays[0];
  await waitFor(() => tray.menu.template[0].label === "TiboTattle · 0% allowance");
  assert.equal(tray.menu.template[0].label, "TiboTattle · 0% allowance");
  assert.equal(tray.menu.template[1].label, "Analyzing");
  assert.equal(tray.titles.at(-1), "0%");
  assert.deepEqual(observed.map((value) => value.state), ["starting", "analyzing"]);
  assert.equal(observed.at(-1).notificationEvidence, null);
  await fixtureValue.lifecycle.dispose();
});

test("lifecycle updates the macOS image only when a dynamic tray state changes", async () => {
  const icons = Object.freeze({
    starting: Object.freeze({ name: "starting" }),
    fresh: Object.freeze({ name: "fresh" }),
  });
  const resolved = [];
  const fixtureValue = fixture({
    fetchImpl: async (url) => jsonResponse(status(), url),
    createTrayIcon: (trayStatus) => {
      resolved.push(trayStatus.status);
      return trayStatus.status === "fresh" ? icons.fresh : icons.starting;
    },
  });

  await fixtureValue.lifecycle.start();
  const tray = fixtureValue.trays[0];
  await waitFor(() => tray.menu.template[0].label === "TiboTattle · 74% allowance");
  assert.equal(tray.initialIcon, icons.starting);
  assert.deepEqual(tray.images, [icons.fresh]);
  assert.ok(resolved.includes("fresh"));

  assert.equal(fixtureValue.lifecycle.setDesktopLanguage("zh-Hans"), true);
  assert.deepEqual(tray.images, [icons.fresh], "locale-only refresh keeps the cached image");
  await fixtureValue.lifecycle.dispose();
});

test("lifecycle stops status polling at recovery and restarts it for bounded retries", async () => {
  const requested = [];
  const fixtureValue = fixture({
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.includes(4801)) return jsonResponse(status(), url);
      throw new Error("private fetch detail");
    },
  });
  await fixtureValue.lifecycle.start();
  await waitFor(() => fixtureValue.trays[0].menu.template[0].label === "TiboTattle · 74% allowance");

  fixtureValue.supervisor.exitHandler({ kind: "companion_exit" });
  assert.equal(fixtureValue.trays[0].menu.template[1].label, "Status unavailable");
  await waitFor(() => requested.length === 2);
  assert.deepEqual(requested, [
    "http://127.0.0.1:4801/api/local/desktop-status",
    "http://127.0.0.1:4802/api/local/desktop-status",
  ]);
  assert.equal(fixtureValue.trays[0].menu.template[1].label, "Status unavailable");
  await fixtureValue.lifecycle.requestQuit();
  assert.equal(fixtureValue.app.quitCalls, 1);
});

test("lifecycle keeps the compact title Darwin-only", async () => {
  for (const platform of ["win32", "linux"]) {
    const fixtureValue = fixture({
      platform,
      fetchImpl: async (url) => jsonResponse(status(), url),
    });
    await fixtureValue.lifecycle.start();
    await waitFor(() => fixtureValue.trays[0].menu.template[0].label === "TiboTattle · 74% allowance");
    // Non-Darwin platforms receive only the existing empty-title clear. They
    // must never receive the numeric compact title intended for macOS.
    assert.ok(fixtureValue.trays[0].titles.length > 0);
    assert.ok(fixtureValue.trays[0].titles.every((value) => value === ""));
    await fixtureValue.lifecycle.dispose();
  }
});

test("macOS primary and secondary tray clicks cannot present both surfaces", async (t) => {
  const f = fixture({ visualTray: true, fetchImpl: async (url) => jsonResponse(status(), url) });
  t.after(() => f.lifecycle.dispose());
  await f.lifecycle.start();
  const tray = f.trays[0];
  // A non-null attached menu lets AppKit show it on the same primary click
  // that opens the BrowserWindow. This is the reported two-overlay defect.
  assert.equal(tray.menu, null);
  tray.emit("click", {});
  const popup = f.windows.find((window) => window.url?.endsWith("/electron-tray-popup.html"));
  await waitFor(() => popup?.isVisible());
  assert.equal(tray.presentedMenus.length, 0);

  tray.emit("right-click", {});
  assert.equal(popup.isVisible(), false);
  assert.equal(tray.presentedMenus.length, 1);
  assert.ok(tray.presentedMenus[0].template.some((item) => item.label === "Settings…"));

  tray.emit("click", {});
  await waitFor(() => popup.isVisible());
  tray.emit("click", { ctrlKey: true });
  assert.equal(popup.isVisible(), false);
  assert.equal(tray.presentedMenus.length, 2);

  // Language/status refresh must update the explicit menu without silently
  // reattaching it and bringing back the overlap on the next click.
  f.lifecycle.setDesktopLanguage("zh-Hans");
  assert.equal(tray.menu, null);
  tray.emit("right-click", {});
  assert.notEqual(tray.presentedMenus[2], tray.presentedMenus[1]);
  assert.ok(tray.presentedMenus[2].template.some((item) => item.label === "设置…"));

  tray.emit("click", {});
  await waitFor(() => popup.isVisible());
  popup.webContents.emit("ipc-message", {
    sender: popup.webContents,
    senderFrame: popup.webContents.mainFrame,
  }, TRAY_POPOVER_ACTION_CHANNEL, "more");
  assert.equal(popup.isVisible(), false);
  assert.equal(tray.presentedMenus.length, 4);
});

test("opening the context menu cancels a pending visual tray load", async (t) => {
  const f = fixture({ visualTray: true, fetchImpl: async (url) => jsonResponse(status(), url) });
  t.after(() => f.lifecycle.dispose());
  await f.lifecycle.start();
  const tray = f.trays[0];
  tray.emit("click", {});
  tray.emit("right-click", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const popup = f.windows.find((window) => window.url?.endsWith("/electron-tray-popup.html"));
  assert.ok(popup);
  assert.equal(popup.isVisible(), false);
  assert.equal(tray.presentedMenus.length, 1);
});

test("a native Windows menu presentation dismisses the visual tray first", async (t) => {
  const f = fixture({ platform: "win32", visualTray: true, fetchImpl: async (url) => jsonResponse(status(), url) });
  t.after(() => f.lifecycle.dispose());
  await f.lifecycle.start();
  const tray = f.trays[0];
  assert.ok(tray.menu);
  tray.emit("click", {});
  const popup = f.windows.find((window) => window.url?.endsWith("/electron-tray-popup.html"));
  await waitFor(() => popup?.isVisible());
  tray.menu.emit("menu-will-show");
  assert.equal(popup.isVisible(), false);
  assert.equal(tray.presentedMenus.length, 0);
});
