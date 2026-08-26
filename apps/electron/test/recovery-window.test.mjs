import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  createRecoveryPageURL,
  createRecoveryWindow,
  installRecoveryWindowPolicy,
  RECOVERY_ACTION_CHANNEL,
  RECOVERY_STATUSES,
  recoveryStatusCopy,
} from "../recovery-window.js";
import { createDesktopLifecycle } from "../desktop-lifecycle.js";

const DASHBOARD_PRELOAD_PATH = resolve("private", "preload.cjs");
const RECOVERY_PRELOAD_PATH = resolve(
  dirname(DASHBOARD_PRELOAD_PATH),
  "recovery-preload.cjs",
);

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.quitCalls = 0;
  }

  requestSingleInstanceLock() {
    return true;
  }

  async whenReady() {}

  quit() {
    this.quitCalls += 1;
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = { isMainFrame: true, parent: null };
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.loaded = [];
  }

  loadURL(url) {
    this.loaded.push(url);
    return Promise.resolve();
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  focus() {}

  isVisible() {
    return this.visible;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeTray extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  setToolTip() {}

  setContextMenu(menu) {
    this.menu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

function makeLifecycle({
  starts,
  desktopLocale = "system",
  desktopSystemLocales,
  desktopActions,
} = {}) {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      const result = starts?.[this.starts - 1] ?? {
        origin: `http://127.0.0.1:${5200 + this.starts}`,
      };
      if (result instanceof Error) throw result;
      return result;
    },
    async stop() {
      this.stops += 1;
    },
  };
  class Window extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: Window,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "test-icon",
    preloadPath: DASHBOARD_PRELOAD_PATH,
    supervisor,
    desktopLocale,
    desktopSystemLocales,
    desktopActions,
  });
  return { app, lifecycle, supervisor, windows };
}

function recoveryWindows(windows) {
  return windows.filter((candidate) => (
    candidate.options.webPreferences.preload === RECOVERY_PRELOAD_PATH
  ));
}

function dashboardWindows(windows) {
  return windows.filter((candidate) => (
    candidate.options.webPreferences.preload === DASHBOARD_PRELOAD_PATH
  ));
}

test("recovery page is fixed, content-free, and never permits remote navigation", () => {
  const page = createRecoveryPageURL("companion_start_timeout");
  assert.match(page, /^data:text\/html;charset=utf-8,/u);
  const html = decodeURIComponent(page);
  assert.match(html, /companion_start_timeout/u);
  assert.match(html, /id="detail"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*tabindex="-1"/u);
  assert.match(html, /getElementById\("detail"\)\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.doesNotMatch(html, /Users|\\\\|\/private/u);

  const webContents = new FakeWebContents();
  const actions = [];
  const policy = installRecoveryWindowPolicy({
    webContents,
    initialURL: page,
    onAction: (action) => actions.push(action),
  });
  let prevented = false;
  assert.equal(policy.setAllowedURL(page), true);
  webContents.emit("will-navigate", {
    preventDefault() {
      prevented = true;
    },
  }, "https://example.test/");
  assert.equal(prevented, true);
  prevented = false;
  webContents.emit("will-frame-navigate", {
    preventDefault() {
      prevented = true;
    },
  }, { url: page, isMainFrame: false });
  assert.equal(prevented, true);
  assert.deepEqual(webContents.windowOpenHandler(), { action: "deny" });
  webContents.emit("ipc-message", {
    sender: webContents,
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "retry");
  webContents.emit("ipc-message", {
    sender: {},
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "quit");
  webContents.emit("ipc-message", {
    sender: webContents,
    frameId: 1,
  }, RECOVERY_ACTION_CHANNEL, "quit");
  assert.deepEqual(actions, ["retry"]);
  policy.remove();
});

test("recovery Diagnostics accepts only an authorized main-frame IPC message", () => {
  const page = createRecoveryPageURL("companion_start_timeout");
  const webContents = new FakeWebContents();
  const actions = [];
  const policy = installRecoveryWindowPolicy({
    webContents,
    initialURL: page,
    onAction: (action) => actions.push(action),
  });

  webContents.emit("ipc-message", {
    sender: webContents,
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "diagnostics");
  webContents.emit("ipc-message", {
    sender: {},
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "diagnostics");
  webContents.emit("ipc-message", {
    sender: webContents,
    frameId: 1,
  }, RECOVERY_ACTION_CHANNEL, "diagnostics");
  webContents.emit("ipc-message", {
    sender: webContents,
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "unknown");

  assert.deepEqual(actions, ["diagnostics"]);
  policy.remove();
});

test("recovery status reload keeps deterministic focus on the non-actionable status region", () => {
  const html = decodeURIComponent(createRecoveryPageURL("companion_ready_invalid"));
  assert.match(html, /<main aria-labelledby="title">/u);
  assert.match(html, /<p class="detail" id="detail"[^>]*tabindex="-1">/u);
  assert.match(
    html,
    /document\.getElementById\("detail"\)\?\.focus\(\{ preventScroll: true \}\);/u,
  );
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'/u);
});

test("recovery Settings is enabled only after startup has failed", () => {
  const starting = decodeURIComponent(createRecoveryPageURL("starting"));
  const failed = decodeURIComponent(createRecoveryPageURL("companion_start_timeout"));
  assert.match(
    starting,
    /<button id="settings" type="button" disabled aria-disabled="true">/u,
  );
  assert.match(failed, /<button id="settings" type="button" >Settings<\/button>/u);
  assert.doesNotMatch(failed, /id="settings"[^>]*disabled/u);
});

test("recovery Settings routes only to the supplied main-process action", async () => {
  const failure = new Error("private startup detail");
  failure.code = "electron_shell_companion_spawn_failed";
  let settingsCalls = 0;
  const { lifecycle, windows } = makeLifecycle({
    starts: [failure],
    desktopActions: {
      recoverySettings: async () => { settingsCalls += 1; },
      settings: async () => {
        throw new Error("normal Settings must not run before companion readiness");
      },
    },
  });
  await lifecycle.start();
  const recovery = recoveryWindows(windows)[0];
  recovery.webContents.emit("ipc-message", {
    sender: recovery.webContents,
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "settings");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settingsCalls, 1);
  await lifecycle.dispose();
});

test("recovery statuses and actions resolve through every supported locale", () => {
  for (const locale of ["en", "zh-Hans", "es"]) {
    for (const status of RECOVERY_STATUSES) {
      const copy = recoveryStatusCopy(status, { locale });
      assert.equal(typeof copy.title, "string");
      assert.equal(typeof copy.detail, "string");
      assert.equal(typeof copy.diagnostic, "string");
      assert.match(copy.diagnostic, new RegExp(copy.code, "u"));
      const html = decodeURIComponent(createRecoveryPageURL(status, { locale }));
      assert.match(html, new RegExp(`<html lang="${locale === "en" ? "en-US" : locale}"`, "u"));
      assert.match(html, new RegExp(copy.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.doesNotMatch(html, /__(?:TITLE|DETAIL|DIAGNOSTIC|RETRY|SETTINGS|QUIT)__/u);
      assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'/u);
    }
  }
  assert.match(
    decodeURIComponent(createRecoveryPageURL("starting", {
      locale: "system",
      systemLocales: ["zh-CN"],
    })),
    /重试/u,
  );
});

test("lifecycle passes the selected desktop locale into the recovery window", async () => {
  const failure = new Error("private startup detail");
  failure.code = "electron_shell_companion_start_timeout";
  const { lifecycle, windows } = makeLifecycle({
    starts: [failure],
    desktopLocale: "es",
  });
  await lifecycle.start();
  const recovery = recoveryWindows(windows)[0];
  const html = decodeURIComponent(recovery.loaded.at(-1));
  assert.match(html, /<html lang="es"/u);
  assert.match(html, /Reintentar/u);
  assert.match(html, /Configuración/u);
  assert.match(html, /Salir/u);
  assert.match(html, /tardando demasiado/u);
  await lifecycle.dispose();
});

test("failed initial launch leaves a visible recovery surface and Retry promotes only the new origin", async () => {
  const firstFailure = new Error("hidden failure");
  firstFailure.code = "electron_shell_companion_start_timeout";
  const { app, lifecycle, supervisor, windows } = makeLifecycle({
    starts: [firstFailure, { origin: "http://127.0.0.1:5299" }],
  });
  const initial = await lifecycle.start();
  assert.deepEqual(initial, {
    status: "recovery",
    origin: null,
    failure: "companion_start_timeout",
  });
  assert.equal(lifecycle.state.started, false);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.equal(lifecycle.showSettingsWindow(), false);
  const recovery = recoveryWindows(windows)[0];
  assert.equal(recovery.destroyed, false);

  recovery.webContents.emit("ipc-message", {
    sender: recovery.webContents,
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "retry");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(lifecycle.state.started, true);
  assert.equal(lifecycle.state.origin, "http://127.0.0.1:5299");
  assert.equal(recovery.destroyed, true);
  assert.equal(dashboardWindows(windows).length, 1);
  assert.deepEqual(dashboardWindows(windows)[0].loaded, ["http://127.0.0.1:5299/"]);
});

test("recovery Quit tears down the companion and app without exposing the error", async () => {
  const failure = new Error("path=/private/secret");
  failure.code = "electron_shell_companion_spawn_failed";
  const { app, lifecycle, supervisor, windows } = makeLifecycle({ starts: [failure] });
  await lifecycle.start();
  const recovery = recoveryWindows(windows)[0];
  recovery.webContents.emit("ipc-message", {
    sender: recovery.webContents,
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "quit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.quitCalls, 1);
  assert.equal(recovery.destroyed, true);
  assert.equal(supervisor.stops, 2);
  assert.doesNotMatch(decodeURIComponent(recovery.loaded.at(-1)), /private|secret/u);
});

test("repeated startup failure stays bounded, visible, and retryable without a stale dashboard", async () => {
  const first = new Error("first");
  first.code = "electron_shell_companion_spawn_failed";
  const second = new Error("second");
  second.code = "electron_shell_companion_ready_invalid";
  const { lifecycle, supervisor, windows } = makeLifecycle({ starts: [first, second] });
  await lifecycle.start();
  const recovery = recoveryWindows(windows)[0];
  const result = await lifecycle.retry();
  assert.deepEqual(result, {
    status: "recovery",
    origin: null,
    failure: "companion_ready_invalid",
  });
  assert.equal(supervisor.starts, 2);
  assert.equal(dashboardWindows(windows).length, 0);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.equal(lifecycle.state.origin, null);
  assert.equal(recovery.destroyed, false);
});

test("an unexpected ready child exit invalidates the old origin before bounded retry", async () => {
  const { lifecycle, supervisor, windows } = makeLifecycle();
  await lifecycle.start();
  const oldDashboard = dashboardWindows(windows)[0];
  supervisor.exitHandler({ kind: "companion_exit" });
  assert.equal(oldDashboard.destroyed, true);
  assert.equal(lifecycle.state.origin, null);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(lifecycle.state.origin, "http://127.0.0.1:5202");
  const dashboards = dashboardWindows(windows);
  assert.equal(dashboards.length, 2);
  assert.deepEqual(dashboards[1].loaded, ["http://127.0.0.1:5202/"]);
  await lifecycle.dispose();
});

test("recovery window keeps the same sandboxed renderer constraints", () => {
  const { lifecycle, windows } = makeLifecycle();
  const promise = lifecycle.start();
  return promise.then(() => {
    const recovery = recoveryWindows(windows)[0];
    assert.equal(recovery.options.webPreferences.nodeIntegration, false);
    assert.equal(recovery.options.webPreferences.contextIsolation, true);
    assert.equal(recovery.options.webPreferences.sandbox, true);
    assert.equal(recovery.options.webPreferences.webSecurity, true);
    assert.equal(recovery.options.webPreferences.partition, "in-memory");
    return lifecycle.dispose();
  });
});

test("createRecoveryWindow exposes only a fixed preload and action surface", () => {
  const actions = [];
  const recovery = createRecoveryWindow({
    BrowserWindow: FakeWindow,
    preloadPath: "/private/recovery-preload.cjs",
    status: "starting",
    onAction: (action) => actions.push(action),
  });
  assert.equal(recovery.window.options.webPreferences.preload, "/private/recovery-preload.cjs");
  assert.equal(recovery.status, "starting");
  recovery.setStatus("companion_spawn_failed");
  assert.equal(recovery.status, "companion_spawn_failed");
  recovery.window.webContents.emit("ipc-message", {
    sender: recovery.window.webContents,
    frameId: 0,
  }, RECOVERY_ACTION_CHANNEL, "settings");
  assert.deepEqual(actions, ["settings"]);
  recovery.destroy();
  assert.equal(recovery.window.destroyed, true);
});
