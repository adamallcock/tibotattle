import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDesktopLifecycle } from "../desktop-lifecycle.js";

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

function status(state = "fresh") {
  return {
    schemaVersion: "tibotattle-desktop-shell-status-v1",
    state,
    allowance: state === "fresh"
      ? { source: "direct", window: "five_hour", remainingPercent: 74 }
      : null,
    notificationEvidence: state === "fresh" ? EVIDENCE : null,
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
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
  }

  loadURL() { return Promise.resolve(); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

class FakeTray extends EventEmitter {
  constructor() {
    super();
    this.menu = null;
    this.titles = [];
  }

  setToolTip() {}
  setContextMenu(menu) { this.menu = menu; }
  setTitle(value) { this.titles.push(value); }
  destroy() {}
}

function fixture({ fetchImpl, onDesktopStatus } = {}) {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
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
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "test-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
    createNavigationPolicy: () => ({}),
    installNavigationPolicy: () => ({ remove() {} }),
    onDesktopStatus,
    desktopStatusMonitorOptions: {
      fetchImpl,
      intervalMs: 60_000,
      timeoutMs: 60_000,
    },
  });
  return { app, lifecycle, supervisor, windows, trays };
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
