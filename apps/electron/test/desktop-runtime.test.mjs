import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { DESKTOP_DEFAULT_SETTINGS } from "../desktop-contract.js";
import { DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION } from "../desktop-first-run.js";
import { launchDesktopRuntime } from "../desktop-runtime.js";
import {
  DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
} from "../../../src/desktop-shell-status.js";

const DEFAULT_CODEX_ROOT_ID = DESKTOP_DEFAULT_SETTINGS.codexHomes.primaryRootId;
const CUSTOM_CODEX_ROOT_ID = "11111111-1111-4111-8111-111111111111";

function customCodexHomes(path, rootId = CUSTOM_CODEX_ROOT_ID) {
  return {
    activityRoots: [{
      rootId,
      kind: "custom",
      path,
      enabled: true,
    }],
    primaryRootId: rootId,
  };
}

function twoCodexHomes(primaryRootId = DEFAULT_CODEX_ROOT_ID) {
  return {
    activityRoots: [
      {
        rootId: DEFAULT_CODEX_ROOT_ID,
        kind: "default",
        path: null,
        enabled: true,
      },
      {
        rootId: CUSTOM_CODEX_ROOT_ID,
        kind: "custom",
        path: "/Users/adam/.codex-custom",
        enabled: true,
      },
    ],
    primaryRootId,
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

class FakeApp extends EventEmitter {
  constructor({ lockResult = true } = {}) {
    super();
    this.isPackaged = false;
    this.quitCalls = 0;
    this.readyCalls = 0;
    this.ready = false;
    this.lockResult = lockResult;
    this.lockCalls = 0;
  }

  requestSingleInstanceLock() {
    this.lockCalls += 1;
    return this.lockResult;
  }

  async whenReady() {
    this.readyCalls += 1;
    this.ready = true;
  }

  getPath(name) {
    assert.equal(name, "userData");
    return "/Users/adam/Library/Application Support/TiboTattle";
  }

  quit() {
    this.quitCalls += 1;
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.session = {};
    this.mainFrame = { isMainFrame: true, parent: null };
    this.commands = [];
    this.url = "";
  }

  send(channel, value) {
    this.commands.push({ channel, value });
  }

  getURL() {
    return this.url;
  }
}

class FakeWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    FakeWindow.instances.push(this);
  }

  loadURL(url) {
    this.webContents.url = url;
    return Promise.resolve();
  }

  once(event, callback) {
    return super.once(event, callback);
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
  static instances = [];

  constructor(...args) {
    super(...args);
    FakeTray.instances.push(this);
  }

  setToolTip() {}

  setContextMenu(menu) {
    this.menu = menu;
  }

  destroy() {}
}

function platformServices() {
  return {
    defaultCodexHome: "/Users/adam/.codex",
    defaultCodexHomeDisplay: "Default location (~/.codex)",
    validateCodexHome: async (path) => path,
    loginItemStatus: () => ({
      status: "unavailable",
      canSet: false,
      detail: "unavailable",
    }),
    setStartAtLogin: () => ({
      status: "unavailable",
      canSet: false,
      detail: "unavailable",
    }),
    notificationStatus: () => ({
      permission: "unavailable",
      available: false,
      detail: "unavailable",
    }),
    chooseCodexHome: async () => "/Users/adam/.codex-custom",
    openSystemSettings: async () => {},
    openExternal: async () => {},
    about: () => ({
      version: "0.1.16",
      build: "test",
      update: { status: "unavailable", canCheck: false, detail: "unavailable" },
      automaticUpdates: {
        enabled: false,
        available: false,
        canSet: false,
        detail: "unavailable",
      },
    }),
  };
}

function notificationBackendFixture({ value = null, events = [] } = {}) {
  let stored = value;
  return {
    get stored() {
      return stored;
    },
    async load() {
      events.push("load");
      return stored;
    },
    async save(next) {
      events.push("save");
      stored = next;
      return next;
    },
  };
}

function runtime(app) {
  return {
    app,
    dialog: {
      showMessageBox: async () => {
        assert.equal(app.ready, true);
        return { response: 0 };
      },
    },
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "test-icon",
  };
}

function shellStatus({ usedPercent, observedAt }) {
  const notificationEvidence = {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt,
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      durationMinutes: 300,
      resetAt: "2026-09-01T10:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
      usedPercent,
    }],
  };
  return {
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state: "fresh",
    allowance: {
      source: "direct",
      window: "five_hour",
      remainingPercent: 100 - usedPercent,
    },
    notificationEvidence: {
      ...notificationEvidence,
      schemaVersion: DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    },
  };
}

function fakeNotification({ supported = true } = {}) {
  const shown = [];
  class FakeNotification {
    static isSupported() {
      return supported;
    }

    constructor(options) {
      shown.push(options);
    }

    show() {}
  }
  return { Notification: FakeNotification, shown };
}

async function launchFixture({
  load,
  save = async () => {},
  platformServices: suppliedPlatformServices,
  notificationBackend = notificationBackendFixture(),
  firstRunReceiptBackend = {
    load: async () => ({
      schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
      acknowledged: true,
    }),
    save: async () => {},
  },
  platform = "darwin",
  argv = [],
  app: suppliedApp,
  runtimeOverrides = {},
  lifecycleOptions = {},
  environment = {
    HOME: "/Users/adam",
    USAGE_MONITOR_RESOURCE_ROOT: "/repo",
  },
} = {}) {
  FakeTray.instances = [];
  FakeWindow.instances = [];
  const app = suppliedApp ?? new FakeApp();
  const children = [];
  const spawnCalls = [];
  const backend = { load, save };
  const launch = launchDesktopRuntime({
    runtime: { ...runtime(app), ...runtimeOverrides },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment,
    platformServices: suppliedPlatformServices ?? platformServices(),
    notificationBackend,
    firstRunReceiptBackend,
    platform,
    argv,
    lifecycleOptions,
    settingsBackend: backend,
    supervisorOptions: {
      spawnChild(_command, args, options) {
        spawnCalls.push({ args: [...args], options });
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  // Attach a rejection observer before the readiness tick. Some negative
  // launch cases fail during controller initialization, before this helper
  // can return its outer promise to the test.
  launch.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  children[0]?.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4811/\n"));
  const desktop = await launch;
  return { app, children, spawnCalls, desktop };
}

test("runtime persists the fixed Electron appearance and updates live renderers", async () => {
  const nativeTheme = new EventEmitter();
  nativeTheme.themeSource = "system";
  nativeTheme.shouldUseDarkColors = true;
  const { desktop } = await launchFixture({
    load: async () => null,
    runtimeOverrides: { nativeTheme },
  });

  assert.equal(nativeTheme.themeSource, "system");
  assert.equal((await desktop.controller.handlers.getSettings()).settings.appearance, "system");

  const dark = await desktop.controller.handlers.setAppearance({ value: "dark" });
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(dark.settings.appearance, "dark");
  assert.ok(FakeWindow.instances.some((candidate) => (
    candidate.webContents.commands.some(({ value }) => (
      value?.command === "appearance"
      && value.preference === "dark"
      && value.resolvedTheme === "dark"
    ))
  )));

  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit("updated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeTheme.themeSource, "dark", "a forced theme remains forced when the system changes");

  await desktop.controller.handlers.setAppearance({ value: "system" });
  assert.equal(nativeTheme.themeSource, "system");
  nativeTheme.emit("updated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(FakeWindow.instances.some((candidate) => (
    candidate.webContents.commands.some(({ value }) => (
      value?.command === "appearance"
      && value.preference === "system"
      && value.resolvedTheme === "light"
    ))
  )));
  await desktop.lifecycle.dispose();
});

test("runtime accepts Codex handoff only from the ready dashboard main frame", async () => {
  const opened = [];
  const ipcMain = {
    handler: null,
    handle(channel, handler) {
      assert.equal(channel, "tibotattle:desktop:v1");
      this.handler = handler;
    },
    removeHandler(channel) {
      assert.equal(channel, "tibotattle:desktop:v1");
      this.handler = null;
    },
  };
  const { desktop } = await launchFixture({
    load: async () => null,
    runtimeOverrides: { ipcMain },
    platformServices: {
      ...platformServices(),
      openCodexThread: async (url) => {
        opened.push(url);
        return true;
      },
    },
  });
  const dashboard = FakeWindow.instances.find((candidate) => (
    candidate.options.webPreferences.preload === "/repo/apps/electron/preload.cjs"
  ));
  assert.notEqual(dashboard, undefined);
  dashboard.emit("ready-to-show");
  assert.equal(desktop.lifecycle.state.dashboardReady, true);
  const canonical = "codex://threads/11111111-1111-4111-8111-111111111111";
  const event = {
    sender: dashboard.webContents,
    senderFrame: dashboard.webContents.mainFrame,
  };
  const dashboardOrigin = "http://127.0.0.1:4811";
  dashboard.webContents.url = `${dashboardOrigin}/#section`;
  assert.equal(
    desktop.lifecycle.isAuthorizedCodexThreadNavigation(
      event.senderFrame,
      { sender: event.sender },
    ),
    true,
  );
  for (const liveURL of [
    `${dashboardOrigin}/electron-settings.html#general`,
    `${dashboardOrigin}/other-dashboard-page`,
    `${dashboardOrigin}/?query`,
  ]) {
    dashboard.webContents.url = liveURL;
    assert.equal(
      desktop.lifecycle.isAuthorizedCodexThreadNavigation(
        event.senderFrame,
        { sender: event.sender },
      ),
      false,
      `same-origin non-dashboard URL must fail closed: ${liveURL}`,
    );
    await assert.rejects(
      ipcMain.handler(event, { action: "openCodexThread", args: { url: canonical } }),
      (error) => error?.code === "desktop_ipc_untrusted_context",
    );
  }
  dashboard.webContents.url = `${dashboardOrigin}/`;
  assert.equal(
    await ipcMain.handler(event, { action: "openCodexThread", args: { url: canonical } }),
    true,
  );
  assert.deepEqual(opened, [canonical]);
  await assert.rejects(
    ipcMain.handler(
      { sender: dashboard.webContents, senderFrame: {} },
      { action: "openCodexThread", args: { url: canonical } },
    ),
    (error) => error?.code === "desktop_ipc_untrusted_context",
  );
  await assert.rejects(
    ipcMain.handler(
      event,
      { action: "openCodexThread", args: { url: `${canonical}?query` } },
    ),
    (error) => error?.code === "desktop_ipc_invalid_request",
  );
  assert.deepEqual(opened, [canonical]);
  assert.equal(
    await ipcMain.handler(event, { action: "openCommunity", args: {} }),
    true,
  );
  assert.deepEqual(dashboard.webContents.commands.at(-1), {
    channel: "tibotattle:desktop-command:v1",
    value: { command: "dashboardSection", section: "community" },
  });
  await assert.rejects(
    ipcMain.handler(
      { sender: dashboard.webContents, senderFrame: {} },
      { action: "openCommunity", args: {} },
    ),
    (error) => error?.code === "desktop_ipc_untrusted_context",
  );
  await assert.rejects(
    ipcMain.handler(event, { action: "openCommunity", args: { extra: true } }),
    (error) => error?.code === "desktop_ipc_invalid_request",
  );
  await desktop.lifecycle.dispose();
});

test("runtime awaits Electron readiness before the first-run native dialog", async () => {
  const app = new FakeApp();
  const dialogCalls = [];
  const children = [];
  const launch = launchDesktopRuntime({
    runtime: {
      ...runtime(app),
      dialog: {
        showMessageBox: async (options) => {
          dialogCalls.push({ ready: app.ready, options });
          return { response: 1 };
        },
      },
    },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment: { HOME: "/Users/adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    platformServices: platformServices(),
    firstRunReceiptBackend: {
      load: async () => null,
      save: async () => {},
    },
    supervisorOptions: {
      spawnChild() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
  });
  const desktop = await launch;
  assert.equal(app.readyCalls, 1);
  assert.deepEqual(dialogCalls.map(({ ready }) => ready), [true]);
  assert.equal(desktop.firstRun.status, "cancelled");
  assert.equal(children.length, 0);
  assert.equal(app.quitCalls, 1);
});

test("runtime uses Electron preferred system languages for first-run copy", async () => {
  const app = new FakeApp();
  app.getPreferredSystemLanguages = () => ["es-ES"];
  app.getLocale = () => "en-US";
  const dialogCalls = [];
  const launch = launchDesktopRuntime({
    runtime: {
      ...runtime(app),
      dialog: {
        showMessageBox: async (options) => {
          dialogCalls.push(options);
          return { response: 1 };
        },
      },
    },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment: { HOME: "/Users/adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    platformServices: platformServices(),
    firstRunReceiptBackend: {
      load: async () => null,
      save: async () => {},
    },
    supervisorOptions: {
      spawnChild() {
        return new FakeChild();
      },
    },
  });
  const desktop = await launch;
  assert.equal(desktop.firstRun.status, "cancelled");
  assert.deepEqual(dialogCalls[0].buttons, ["Continuar", "Salir"]);
  assert.match(dialogCalls[0].detail, /servicio auxiliar|contribución/u);
});

test("runtime applies persisted custom CODEX_HOME before first child start", async () => {
  const fixture = await launchFixture({
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: customCodexHomes("/Users/adam/.codex-first"),
    }),
  });
  assert.equal(fixture.desktop.childEnvironment.CODEX_HOME, "/Users/adam/.codex-first");
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime launches the companion with only the selected primary CODEX_HOME", async () => {
  const fixture = await launchFixture({
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: twoCodexHomes(CUSTOM_CODEX_ROOT_ID),
    }),
  });
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  assert.equal(fixture.spawnCalls[0].options.env.CODEX_HOME, "/Users/adam/.codex-custom");

  const roots = await fixture.desktop.controller.handlers.getCodexHomesForSettings({});
  assert.deepEqual(roots.activityRoots.map(({ rootId }) => rootId), [
    DEFAULT_CODEX_ROOT_ID,
    CUSTOM_CODEX_ROOT_ID,
  ]);
  const setPrimary = fixture.desktop.controller.handlers.setPrimaryCodexHome({
    rootId: DEFAULT_CODEX_ROOT_ID,
  });
  for (let attempt = 0; attempt < 20 && fixture.children.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.children.length, 2);
  fixture.children[1].stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4812/\n"));
  await setPrimary;
  assert.deepEqual(fixture.spawnCalls[1].args, ["/repo/apps/local/server.js"]);
  assert.equal(fixture.spawnCalls[1].options.env.CODEX_HOME, "/Users/adam/.codex");
  const persisted = await fixture.desktop.controller.handlers.getCodexHomesForSettings({});
  assert.deepEqual(persisted.activityRoots.map(({ rootId }) => rootId), [
    DEFAULT_CODEX_ROOT_ID,
    CUSTOM_CODEX_ROOT_ID,
  ]);
  assert.equal(persisted.primaryRootId, DEFAULT_CODEX_ROOT_ID);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime rejects a root path written in the wrong host grammar before spawning", async () => {
  await assert.rejects(
    launchFixture({
      platform: "darwin",
      load: async () => ({
        ...DESKTOP_DEFAULT_SETTINGS,
        codexHomes: customCodexHomes("C:\\Users\\adam\\.codex"),
      }),
    }),
    (error) => error?.code === "electron_shell_desktop_codex_roots_invalid",
  );

  await assert.rejects(
    launchFixture({
      platform: "win32",
      platformServices: {
        ...platformServices(),
        defaultCodexHome: "C:\\Users\\adam\\.codex",
      },
      environment: {
        USERPROFILE: "C:\\Users\\adam",
        USAGE_MONITOR_RESOURCE_ROOT: "/repo",
      },
      load: async () => ({
        ...DESKTOP_DEFAULT_SETTINGS,
        codexHomes: customCodexHomes("/Users/adam/.codex"),
      }),
    }),
    (error) => error?.code === "electron_shell_desktop_codex_roots_invalid",
  );
});

test("runtime wires safe browser, diagnostics, and local-data actions", async () => {
  const external = [];
  const revealed = [];
  const copied = [];
  const dialogs = [];
  const fixture = await launchFixture({
    load: async () => null,
    runtimeOverrides: {
      dialog: {
        showMessageBox: async (options) => {
          dialogs.push(options);
          return { response: 0 };
        },
      },
      shell: {
        openExternal: async (url) => external.push(url),
        showItemInFolder: (path) => revealed.push(path),
      },
      clipboard: {
        writeText: (value) => copied.push(value),
      },
    },
  });

  assert.equal(await fixture.desktop.controller.handlers.openDashboardInBrowser({}), true);
  assert.deepEqual(external, ["http://127.0.0.1:4811/"]);

  assert.equal(await fixture.desktop.controller.handlers.revealLocalData({}), true);
  assert.deepEqual(revealed, ["/Users/adam/Library/Application Support/TiboTattle/companion-state"]);

  assert.deepEqual(
    await fixture.desktop.controller.handlers.showDiagnostics({}),
    { status: "copied" },
  );
  assert.equal(dialogs.length, 1);
  assert.equal(copied.length, 1);
  assert.equal(copied[0], dialogs[0].detail);
  assert.match(dialogs[0].detail, /tibotattle-electron-diagnostics-v1/u);
  assert.doesNotMatch(dialogs[0].detail, /Users|127\.0\.0\.1|codex-first/u);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime applies the persisted desktop language to the initial tray menu", async () => {
  const fixture = await launchFixture({
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      language: "zh-Hans",
    }),
  });
  const tray = FakeTray.instances.at(-1);
  assert.equal(tray.menu.template.find((item) => item.label === "打开 TiboTattle")?.label, "打开 TiboTattle");
  await fixture.desktop.lifecycle.dispose();
});

test("runtime invalidates a dashboard refresh lease when its renderer is replaced", async () => {
  const fixture = await launchFixture({
    load: async () => null,
  });
  const dashboard = FakeWindow.instances.find((candidate) => (
    candidate.options.webPreferences.preload === "/repo/apps/electron/preload.cjs"
  ));
  assert.notEqual(dashboard, undefined);
  dashboard.emit("ready-to-show");
  const lease = await fixture.desktop.controller.handlers.refreshStarted();
  dashboard.webContents.emit("render-process-gone", {}, {
    reason: "crashed",
    exitCode: 17,
  });
  assert.equal(
    await fixture.desktop.controller.handlers.refreshSettled({ lease }),
    false,
    "a replaced dashboard cannot settle the abandoned renderer lease",
  );
  await fixture.desktop.lifecycle.dispose();
});

test("runtime queues Linux launch links until the dashboard is ready and sends only the fixed wake command", async () => {
  const fixture = await launchFixture({
    platform: "linux",
    load: async () => null,
    argv: [
      "/opt/TiboTattle/tibotattle",
      "usagemonitor://open",
      "https://attacker.example/steal?token=secret",
      "usagemonitor://open?token=secret",
    ],
  });
  const dashboard = FakeWindow.instances.find((candidate) => (
    candidate.options.webPreferences.preload === "/repo/apps/electron/preload.cjs"
  ));
  assert.notEqual(dashboard, undefined);
  assert.deepEqual(dashboard.webContents.commands, []);
  dashboard.emit("ready-to-show");
  assert.deepEqual(dashboard.webContents.commands, [{
    channel: "tibotattle:desktop-command:v1",
    value: { command: "hostedSignInReturn" },
  }]);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime accepts a macOS open-url and a late second-instance link, but rejected links are inert", async () => {
  const fixture = await launchFixture({ platform: "darwin", argv: [], load: async () => null });
  const dashboard = FakeWindow.instances.find((candidate) => (
    candidate.options.webPreferences.preload === "/repo/apps/electron/preload.cjs"
  ));
  const openEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  fixture.app.emit("open-url", openEvent, "usagemonitor://open/");
  assert.equal(openEvent.prevented, true);
  fixture.app.emit("second-instance", {}, [
    "/Applications/TiboTattle Dev.app/Contents/MacOS/TiboTattle Dev",
    "usagemonitor://open?credential=secret",
    "usagemonitor://open",
  ]);
  assert.deepEqual(dashboard.webContents.commands, []);
  dashboard.emit("ready-to-show");
  assert.deepEqual(dashboard.webContents.commands.map(({ value }) => value), [
    { command: "hostedSignInReturn" },
    { command: "hostedSignInReturn" },
  ]);
  await fixture.desktop.lifecycle.dispose();
});

test("a secondary Electron instance exits before first-run or companion startup", async () => {
  const app = new FakeApp({ lockResult: false });
  const fixture = await launchFixture({
    app,
    platform: "linux",
    argv: ["usagemonitor://open"],
    load: async () => null,
  });
  assert.equal(fixture.desktop.status, "secondary_instance");
  assert.equal(app.quitCalls, 1);
  assert.equal(app.readyCalls, 0);
  assert.equal(fixture.children.length, 0);
});

test("runtime retains a configured root when its path is currently unavailable", async () => {
  const validated = [];
  const missing = "/Users/adam/.codex-gone";
  const services = {
    ...platformServices(),
    validateCodexHome: async (path) => {
      validated.push(path);
      throw new Error("saved folder disappeared");
    },
  };
  const fixture = await launchFixture({
    platformServices: services,
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: customCodexHomes(missing),
    }),
  });
  assert.deepEqual(validated, []);
  assert.equal(fixture.desktop.childEnvironment.CODEX_HOME, missing);
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  assert.equal(
    (await fixture.desktop.controller.handlers.getCodexHomesForSettings({})).activityRoots[0].path,
    missing,
  );
  const settings = await fixture.desktop.controller.handlers.getSettings({});
  assert.equal(settings.settings.codexFolder.kind, "custom");
  assert.equal(Object.hasOwn(settings.settings.codexFolder, "recovery"), false);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime keeps the prior child and environment when root persistence fails", async () => {
  let saves = 0;
  const fixture = await launchFixture({
    load: async () => null,
    save: async () => {
      saves += 1;
      throw new Error("synthetic persistence failure");
    },
  });
  await assert.rejects(
    fixture.desktop.controller.handlers.chooseCodexHome({}),
    (error) => error?.code === "desktop_codex_roots_persistence_failed",
  );
  assert.equal(saves, 1);
  assert.equal(fixture.children.length, 1);
  assert.equal(fixture.desktop.childEnvironment.CODEX_HOME, "/Users/adam/.codex");
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime keeps policy persistence separate and delivers one localized crossing", async () => {
  const fake = fakeNotification();
  const policyEvents = [];
  const policyBackend = notificationBackendFixture({ events: policyEvents });
  const app = new FakeApp();
  app.isPackaged = true;
  const fixture = await launchFixture({
    app,
    runtimeOverrides: { Notification: fake.Notification },
    notificationBackend: policyBackend,
    load: async () => null,
  });
  assert.deepEqual(policyEvents.slice(0, 2), ["load", "save"]);
  await fixture.desktop.controller.handlers.setLanguage({ value: "es" });
  await fixture.desktop.notificationCoordinator.setPreferences({
    enabled: true,
    threshold: "ninety",
  });
  const first = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 40,
    observedAt: "2026-08-22T10:00:00.000Z",
  }));
  const crossing = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 95,
    observedAt: "2026-08-22T10:05:00.000Z",
  }));
  const duplicate = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 95,
    observedAt: "2026-08-22T10:06:00.000Z",
  }));
  assert.equal(first.outcome, "first_observation");
  assert.equal(crossing.outcome, "notification");
  assert.equal(duplicate.outcome, "no_crossing");
  assert.equal(fake.shown.length, 1);
  assert.equal(fake.shown[0].title, "El uso de la cuota alcanzó el 90 %");
  assert.match(fake.shown[0].body, /superó el umbral/u);
  assert.ok(policyEvents.includes("save"));
  const recovery = await fixture.desktop.notificationCoordinator.evaluate({
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state: "stale",
    allowance: null,
    notificationEvidence: null,
  });
  assert.equal(recovery.outcome, "ineligible");
  const afterRecovery = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 95,
    observedAt: "2026-08-22T10:10:00.000Z",
  }));
  assert.equal(afterRecovery.outcome, "first_observation");
  await fixture.desktop.lifecycle.dispose();
  assert.equal(fixture.desktop.notificationCoordinator.status().state, "disposed");
});

test("runtime truthfully gates development and Windows notification identity", async () => {
  const development = await launchFixture({
    load: async () => null,
    notificationBackend: notificationBackendFixture(),
  });
  const developmentSettings = await development.desktop.controller.handlers.getSettings({});
  assert.equal(developmentSettings.settings.notifications.delivery, "not_packaged");
  await development.desktop.lifecycle.dispose();

  const fake = fakeNotification();
  const app = new FakeApp();
  app.isPackaged = true;
  const windowsServices = {
    ...platformServices(),
    defaultCodexHome: "C:\\Users\\adam\\.codex",
  };
  const windows = await launchFixture({
    app,
    platform: "win32",
    platformServices: windowsServices,
    runtimeOverrides: { Notification: fake.Notification },
    notificationBackend: notificationBackendFixture(),
    load: async () => null,
    environment: {
      USERPROFILE: "C:\\Users\\adam",
      USAGE_MONITOR_RESOURCE_ROOT: "/repo",
    },
  });
  const windowsSettings = await windows.desktop.controller.handlers.getSettings({});
  assert.equal(
    windowsSettings.settings.notifications.delivery,
    "windows_identity_unavailable",
  );
  assert.equal(windowsSettings.settings.notifications.canSet, false);
  await windows.desktop.lifecycle.dispose();
});

test("fresh first-run login choice is applied once without changing the receipt", async () => {
  const calls = [];
  let loginEnabled = false;
  const services = {
    ...platformServices(),
    loginItemStatus: () => ({
      status: loginEnabled ? "enabled" : "disabled",
      canSet: true,
      detail: "fixed",
    }),
    setStartAtLogin: (enabled) => {
      calls.push(enabled);
      loginEnabled = enabled;
      return {
        status: enabled ? "enabled" : "disabled",
        canSet: true,
        detail: "fixed",
      };
    },
  };
  const dialogs = [];
  const app = new FakeApp();
  const firstRunReceiptBackend = {
    value: null,
    async load() {
      return this.value;
    },
    async save(value) {
      this.value = value;
    },
  };
  const launch = launchDesktopRuntime({
    runtime: {
      ...runtime(app),
      dialog: {
        async showMessageBox(options) {
          dialogs.push(options);
          return dialogs.length === 1
            ? { response: 0, checkboxChecked: true }
            : { response: 0 };
        },
      },
    },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment: { HOME: "/Users/adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    platformServices: services,
    settingsBackend: {
      async load() {
        return null;
      },
      async save() {},
    },
    firstRunReceiptBackend,
    notificationBackend: notificationBackendFixture(),
    supervisorOptions: {
      spawnChild() {
        const child = new FakeChild();
        queueMicrotask(() => child.stdout.emit(
          "data",
          Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4811/\n"),
        ));
        return child;
      },
    },
  });
  const desktop = await launch;
  assert.deepEqual(desktop.firstRunLogin, { status: "enabled" });
  assert.deepEqual(calls, [true]);
  assert.equal(firstRunReceiptBackend.value.acknowledged, true);
  assert.equal(Object.hasOwn(firstRunReceiptBackend.value, "startAtLogin"), false);
  assert.equal(dialogs.length, 1);
  await desktop.lifecycle.dispose();
});

test("Windows qualification rejects injected notification persistence", async () => {
  const app = new FakeApp();
  await assert.rejects(
    launchDesktopRuntime({
      runtime: runtime(app),
      app,
      paths: {
        companionScript: "/repo/apps/local/server.js",
        companionCwd: "/repo",
        resourceRoot: "/repo",
        preloadPath: "/repo/apps/electron/preload.cjs",
      },
      platform: "win32",
      qualificationContext: {},
      notificationBackend: notificationBackendFixture(),
      environment: { USERPROFILE: "C:\\Users\\adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    }),
    (error) => error?.code === "electron_shell_windows_qualification_launch_override_forbidden",
  );
});
