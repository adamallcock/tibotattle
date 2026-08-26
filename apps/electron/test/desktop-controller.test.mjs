import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_DEFAULT_SETTINGS } from "../desktop-contract.js";
import {
  createDesktopController,
  DESKTOP_REFRESH_LEASE_WATCHDOG_MS,
} from "../desktop-controller.js";
import {
  createDefaultCodexHomes,
  normalizeCodexHomes,
} from "../desktop-codex-roots.js";
import { createDesktopSettingsStore } from "../desktop-settings-store.js";

const ROOT_A = "11111111-1111-4111-8111-111111111111";
const ROOT_B = "22222222-2222-4222-8222-222222222222";

function twoCodexHomes() {
  return normalizeCodexHomes({
    activityRoots: [
      { rootId: ROOT_A, kind: "custom", path: "/Users/adam/codex-a", enabled: true },
      { rootId: ROOT_B, kind: "custom", path: "/Users/adam/codex-b", enabled: true },
    ],
    primaryRootId: ROOT_A,
  });
}

function fixture({
  platformOverrides = {},
  lifecycleOverrides = {},
  actionOverrides = {},
  settingsLoad = async () => null,
  settingsSave = null,
  settingsStore: suppliedSettingsStore = null,
} = {}) {
  let persisted = null;
  const store = suppliedSettingsStore ?? createDesktopSettingsStore({
    backend: {
      load: settingsLoad,
      save: async (value) => {
        persisted = value;
        if (settingsSave !== null) await settingsSave(value);
      },
    },
  });
  const commands = [];
  const homes = [];
  const hostedSignIns = [];
  const settingsWindows = [];
  const timers = [];
  const cleared = [];
  const languageChanges = [];
  let notificationStatus = {
    state: "ready",
    enabled: false,
    threshold: "off",
    resetEnabled: true,
    delivery: "ready",
    lastOutcome: "initialized",
    lastReason: "none",
    lastDelivery: "not_attempted",
  };
  const notificationCoordinator = {
    initialize: async () => ({ status: notificationStatus }),
    status: () => notificationStatus,
    setPreferences: async (preferences) => {
      notificationStatus = {
        ...notificationStatus,
        enabled: preferences.enabled,
        threshold: preferences.threshold,
        lastOutcome: "preferences_updated",
      };
      return { status: notificationStatus };
    },
  };
  let login = { status: "disabled", canSet: true, detail: "disabled" };
  const platform = {
    defaultCodexHomeDisplay: "Default location (~/.codex)",
    loginItemStatus: () => login,
    setStartAtLogin(enabled) {
      login = {
        status: enabled ? "enabled" : "disabled",
        canSet: true,
        detail: enabled ? "enabled" : "disabled",
      };
      return login;
    },
    notificationStatus: () => ({
      permission: "unknown",
      available: true,
      detail: "unknown",
    }),
    chooseCodexHome: async () => "/Users/adam/custom-codex",
    openSystemSettings: async () => {},
    openExternal: async () => {},
    openHostedSignIn: async (authorizeUrl) => hostedSignIns.push(authorizeUrl),
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
    ...platformOverrides,
  };
  const controller = createDesktopController({
    settingsStore: store,
    platformServices: platform,
    notificationCoordinator,
    getLifecycle: () => ({
      showSettingsWindow(section) {
        settingsWindows.push(section);
        return true;
      },
      ...lifecycleOverrides,
    }),
    applyCodexHome: async (next, previous) => homes.push([next, previous]),
    validateCodexHome: async (path) => path,
    sendDashboardCommand: (value) => {
      commands.push(value);
      return true;
    },
    onLanguageChanged: (value) => {
      languageChanges.push(value);
      return true;
    },
    ...actionOverrides,
    setRecurringTimer(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearRecurringTimer: (timer) => cleared.push(timer),
  });
  return {
    controller,
    store,
    commands,
    homes,
    hostedSignIns,
    settingsWindows,
    timers,
    cleared,
    languageChanges,
    notificationCoordinator,
    get persisted() { return persisted; },
  };
}

test("controller initializes persisted cadence and projects truthful settings state", async () => {
  const value = fixture();
  const snapshot = await value.controller.initialize();
  assert.deepEqual(value.homes, [[{ mode: "default", path: null }, null]]);
  assert.equal(value.timers.length, 1);
  assert.equal(value.timers[0].milliseconds, 300_000);
  assert.deepEqual(value.languageChanges, ["system"]);
  assert.deepEqual(snapshot, {
      settings: {
        language: "system",
        appearance: "system",
        codexFolder: { kind: "default" },
        codexHomes: {
          activityRoots: [{
            rootId: DESKTOP_DEFAULT_SETTINGS.codexHomes.primaryRootId,
            kind: "default",
            enabled: true,
          }],
          primaryRootId: DESKTOP_DEFAULT_SETTINGS.codexHomes.primaryRootId,
        },
        refreshIntervalSeconds: 300,
        startAtLogin: { status: "disabled", canSet: true, detail: "disabled" },
        sidebarCollapsed: false,
      notifications: {
        enabled: false,
        threshold: "off",
        canSet: true,
        state: "ready",
        delivery: "ready",
        lastOutcome: "preferences_updated",
        lastReason: "none",
        lastDelivery: "not_attempted",
        permission: "unknown",
        detail: "Local allowance alerts are ready. Alerts use fresh provider-reported evidence only.",
      },
    },
    about: {
      version: "0.1.16",
      build: "test",
      update: { status: "unavailable", canCheck: false, detail: "unavailable" },
      automaticUpdates: {
        enabled: false,
        available: false,
        canSet: false,
        detail: "unavailable",
      },
    },
  });
  value.timers[0].callback();
  assert.deepEqual(value.commands, [{ command: "refresh" }]);
});

test("controller implements every bounded bridge action and desktop command", async () => {
  const value = fixture();
  await value.controller.initialize();
  await value.controller.handlers.openSettings({});
  await value.controller.handlers.setLanguage({ value: "es" });
  await value.controller.handlers.setRefreshInterval({ seconds: 60 });
  await value.controller.handlers.setStartAtLogin({ enabled: true });
  await value.controller.handlers.setNotificationPreferences({
    enabled: false,
    threshold: "off",
  });
  await value.controller.handlers.openHostedSignIn({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
  });
  const selected = await value.controller.handlers.chooseCodexHome({});
  assert.deepEqual(value.settingsWindows, ["general"]);
  assert.deepEqual(value.commands, [{ command: "language", value: "es" }]);
  assert.deepEqual(value.languageChanges, ["system", "es"]);
  assert.equal(value.timers.at(-1).milliseconds, 60_000);
  assert.equal(value.cleared.length, 1);
  assert.equal(selected.settings.codexFolder.kind, "custom");
  assert.deepEqual(selected.settings.codexFolder, { kind: "custom" });
  assert.doesNotMatch(JSON.stringify(selected), /\/Users\/adam/u);
  assert.deepEqual(value.hostedSignIns, [
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
  ]);
  assert.equal(value.persisted.schemaVersion, DESKTOP_DEFAULT_SETTINGS.schemaVersion);
  assert.equal(Object.hasOwn(value.persisted, "codexHome"), false);
  assert.equal(value.persisted.codexHomes.activityRoots.length, 1);
  assert.equal(value.persisted.codexHomes.activityRoots[0].kind, "custom");
  assert.equal(value.persisted.codexHomes.activityRoots[0].path, "/Users/adam/custom-codex");
  assert.equal(
    value.persisted.codexHomes.primaryRootId,
    value.persisted.codexHomes.activityRoots[0].rootId,
  );
  assert.equal(value.persisted.language, "es");
  assert.equal(value.persisted.refreshIntervalSeconds, 60);
  assert.equal(value.persisted.startAtLogin, true);
  assert.deepEqual(value.persisted.notifications, { enabled: false, threshold: "off" });
});

test("controller exposes bounded browser, diagnostics, local-data, and refresh lifecycle actions", async () => {
  const actions = [];
  const value = fixture({
    actionOverrides: {
      openDashboardInBrowserAction: async () => actions.push("browser"),
      showDiagnosticsAction: async () => actions.push("diagnostics"),
      revealLocalDataAction: async () => actions.push("local-data"),
    },
  });
  await value.controller.initialize();
  await value.controller.handlers.openDashboardInBrowser({});
  await value.controller.handlers.showDiagnostics({});
  await value.controller.handlers.revealLocalData({});
  assert.deepEqual(actions, ["browser", "diagnostics", "local-data"]);

  value.timers[0].callback();
  assert.deepEqual(value.commands, [{ command: "refresh" }]);
  const fallbackTimer = value.timers.at(-1);
  assert.notEqual(fallbackTimer, value.timers[0]);
  fallbackTimer.callback();
  assert.deepEqual(
    value.commands,
    [{ command: "refresh" }],
    "a delivered-but-unaccepted tick only rearms the cadence; it does not spin refresh commands",
  );
  const rearmedTimer = value.timers.at(-1);
  assert.notEqual(rearmedTimer, fallbackTimer);
  const lease = await value.controller.handlers.refreshStarted({});
  assert.equal(lease, 1);
  assert.equal(value.timers.at(-1).milliseconds, DESKTOP_REFRESH_LEASE_WATCHDOG_MS);
  assert.ok(value.cleared.includes(rearmedTimer));
  assert.equal(await value.controller.handlers.refreshSettled({}), false);
  assert.equal(await value.controller.handlers.refreshSettled({ lease }), true);
  assert.equal(value.timers.at(-1).milliseconds, 300_000);
});

test("refresh leases ignore stale completion and only the current lease rearms cadence", async () => {
  const value = fixture();
  await value.controller.initialize();
  const leaseA = await value.controller.handlers.refreshStarted({});
  const watchdogA = value.timers.at(-1);
  const leaseB = await value.controller.handlers.refreshStarted({});
  const watchdogB = value.timers.at(-1);
  assert.deepEqual([leaseA, leaseB], [1, 2]);
  assert.equal(watchdogA.milliseconds, DESKTOP_REFRESH_LEASE_WATCHDOG_MS);
  assert.ok(value.cleared.includes(watchdogA));
  assert.equal(await value.controller.handlers.refreshSettled({ lease: leaseA }), false);
  assert.equal(value.timers.at(-1), watchdogB);
  assert.equal(await value.controller.handlers.refreshSettled({ lease: leaseB }), true);
  assert.equal(value.timers.at(-1).milliseconds, 300_000);
});

test("changing the refresh interval during an active lease persists without arming a timer", async () => {
  const value = fixture();
  await value.controller.initialize();
  const lease = await value.controller.handlers.refreshStarted({});
  const timerCount = value.timers.length;
  await value.controller.handlers.setRefreshInterval({ seconds: 60 });
  assert.equal(value.timers.length, timerCount);
  assert.equal((await value.store.getSettings()).refreshIntervalSeconds, 60);
  assert.equal(await value.controller.handlers.refreshSettled({ lease }), true);
  assert.equal(value.timers.at(-1).milliseconds, 60_000);
});

test("dashboard replacement releases an abandoned lease and rearms the cadence", async () => {
  const value = fixture();
  await value.controller.initialize();
  const lease = await value.controller.handlers.refreshStarted({});
  const watchdog = value.timers.at(-1);
  assert.equal(value.controller.reconcileDashboardSession(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(value.cleared.includes(watchdog));
  assert.equal(await value.controller.handlers.refreshSettled({ lease }), false);
  assert.equal(value.timers.at(-1).milliseconds, 300_000);
});

test("lease watchdog recovers cadence after a renderer disappears", async () => {
  const value = fixture();
  await value.controller.initialize();
  await value.controller.handlers.refreshStarted({});
  const watchdog = value.timers.at(-1);
  watchdog.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.timers.at(-1).milliseconds, 300_000);
});

test("controller persists sidebar collapse and sends only the bounded presentation command", async () => {
  const value = fixture();
  await value.controller.initialize();
  const collapsed = await value.controller.toggleSidebar();
  assert.equal(collapsed.settings.sidebarCollapsed, true);
  assert.deepEqual(value.commands, [{ command: "sidebar", collapsed: true }]);
  assert.equal((await value.store.getSettings()).sidebarCollapsed, true);

  const restored = await value.controller.toggleSidebar();
  assert.equal(restored.settings.sidebarCollapsed, false);
  assert.deepEqual(value.commands, [
    { command: "sidebar", collapsed: true },
    { command: "sidebar", collapsed: false },
  ]);
});

test("controller persists notification preferences only after coordinator confirmation", async () => {
  const value = fixture();
  await value.controller.initialize();
  const enabled = await value.controller.handlers.setNotificationPreferences({
    enabled: true,
    threshold: "ninety",
  });
  assert.equal(enabled.settings.notifications.enabled, true);
  assert.equal(enabled.settings.notifications.threshold, "ninety");
  assert.deepEqual((await value.store.getSettings()).notifications, {
    enabled: true,
    threshold: "ninety",
  });
  const disabled = await value.controller.handlers.setNotificationPreferences({
    enabled: false,
    threshold: "off",
  });
  assert.equal(disabled.settings.notifications.enabled, false);
  assert.equal(disabled.settings.notifications.threshold, "off");
});

test("controller gates notification mutations when native delivery is unavailable", async () => {
  const value = fixture();
  value.notificationCoordinator.status = () => ({
    state: "ready",
    enabled: false,
    threshold: "off",
    resetEnabled: true,
    delivery: "not_packaged",
    lastOutcome: "initialized",
    lastReason: "none",
    lastDelivery: "not_attempted",
  });
  const snapshot = await value.controller.initialize();
  assert.equal(snapshot.settings.notifications.canSet, false);
  assert.equal(snapshot.settings.notifications.delivery, "not_packaged");
  await assert.rejects(
    value.controller.handlers.setNotificationPreferences({ enabled: true, threshold: "ninety" }),
    (error) => error?.code === "desktop_notifications_unavailable",
  );
});

test("controller rolls coordinator back when ordinary settings persistence fails", async () => {
  const preferences = [];
  const store = createDesktopSettingsStore({
    backend: {
      load: async () => null,
      save: async (value) => {
        if (value.notifications.enabled === true) throw new Error("settings unavailable");
      },
    },
  });
  const coordinator = {
    state: { state: "ready", enabled: false, threshold: "off", delivery: "ready", lastOutcome: "initialized", lastReason: "none", lastDelivery: "not_attempted" },
    initialize: async () => ({}),
    status() { return this.state; },
    async setPreferences(next) {
      preferences.push(next);
      this.state = { ...this.state, enabled: next.enabled, threshold: next.threshold };
      return { status: this.state };
    },
  };
  const value = fixture();
  const controller = createDesktopController({
    settingsStore: store,
    platformServices: {
      defaultCodexHomeDisplay: "Default",
      loginItemStatus: () => ({ status: "disabled", canSet: false, detail: "disabled" }),
      setStartAtLogin: () => ({ status: "unavailable", canSet: false, detail: "unavailable" }),
      notificationStatus: () => ({ permission: "unavailable", detail: "unavailable" }),
      chooseCodexHome: async () => null,
      openSystemSettings: async () => {},
      openExternal: async () => {},
      about: () => ({}),
    },
    notificationCoordinator: coordinator,
    getLifecycle: () => ({ showSettingsWindow: () => true }),
    applyCodexHome: async () => {},
    validateCodexHome: async (path) => path,
    sendDashboardCommand: () => false,
    setRecurringTimer: () => ({ unref() {} }),
    clearRecurringTimer: () => {},
  });
  await controller.initialize();
  await assert.rejects(
    controller.handlers.setNotificationPreferences({ enabled: true, threshold: "ninety" }),
    (error) => error?.code === "desktop_notifications_persistence_failed",
  );
  assert.deepEqual(preferences.map(({ enabled, threshold }) => ({ enabled, threshold })), [
    { enabled: false, threshold: "off" },
    { enabled: true, threshold: "ninety" },
    { enabled: false, threshold: "off" },
  ]);
});

test("controller fails closed when notification rollback cannot be proven", async () => {
  const store = createDesktopSettingsStore({
    backend: {
      load: async () => null,
      save: async () => { throw new Error("settings unavailable"); },
    },
  });
  let calls = 0;
  let status = {
    state: "ready",
    enabled: false,
    threshold: "off",
    delivery: "ready",
    lastOutcome: "initialized",
    lastReason: "none",
    lastDelivery: "not_attempted",
  };
  const coordinator = {
    initialize: async () => ({}),
    status: () => status,
    setPreferences: async (next) => {
      calls += 1;
      status = { ...status, enabled: next.enabled, threshold: next.threshold };
      if (calls === 3) return { status: { ...status, state: "state_unavailable", delivery: "state_unavailable" } };
      return { status };
    },
  };
  const value = fixture();
  const controller = createDesktopController({
    settingsStore: store,
    platformServices: {
      defaultCodexHomeDisplay: "Default",
      loginItemStatus: () => ({ status: "disabled", canSet: false, detail: "disabled" }),
      setStartAtLogin: () => ({ status: "unavailable", canSet: false, detail: "unavailable" }),
      notificationStatus: () => ({ permission: "unavailable", detail: "unavailable" }),
      chooseCodexHome: async () => null,
      openSystemSettings: async () => {},
      openExternal: async () => {},
      about: () => ({}),
    },
    notificationCoordinator: coordinator,
    getLifecycle: () => ({ showSettingsWindow: () => true }),
    applyCodexHome: async () => {},
    validateCodexHome: async (path) => path,
    sendDashboardCommand: () => false,
    setRecurringTimer: () => ({ unref() {} }),
    clearRecurringTimer: () => {},
  });
  await controller.initialize();
  await assert.rejects(
    controller.handlers.setNotificationPreferences({ enabled: true, threshold: "ninety" }),
    (error) => error?.code === "desktop_notifications_rollback_failed",
  );
  const snapshot = await controller.handlers.getSettings();
  assert.equal(snapshot.settings.notifications.enabled, false);
  assert.equal(snapshot.settings.notifications.canSet, false);
  assert.equal(snapshot.settings.notifications.state, "state_unavailable");
});

test("controller permits reveal only for the live dashboard context", async () => {
  const value = fixture({
    lifecycleOverrides: {
      isAuthorizedDesktopDownloadContext(sender, frame) {
        return sender === "dashboard" && frame === "dashboard-frame";
      },
      revealLatestDownload: async () => "revealed",
    },
  });
  await value.controller.initialize();
  await assert.rejects(
    value.controller.handlers.revealLatestDownload({}, {
      sender: "settings",
      senderFrame: "settings-frame",
    }),
    (error) => error?.code === "desktop_download_unavailable",
  );
  assert.equal(
    await value.controller.handlers.revealLatestDownload({}, {
      sender: "dashboard",
      senderFrame: "dashboard-frame",
    }),
    "revealed",
  );
});

test("Codex root change persists before process configuration when persistence fails", async () => {
  let saves = 0;
  const store = createDesktopSettingsStore({
    backend: {
      load: async () => null,
      async save() {
        saves += 1;
        throw new Error("private failure");
      },
    },
  });
  const homes = [];
  const controller = createDesktopController({
    settingsStore: store,
    platformServices: {
      defaultCodexHomeDisplay: "Default",
      loginItemStatus: () => ({ status: "unavailable", canSet: false, detail: "n/a" }),
      setStartAtLogin: () => ({ status: "unavailable", canSet: false, detail: "n/a" }),
      notificationStatus: () => ({ permission: "unavailable", detail: "n/a" }),
      chooseCodexHome: async () => "/safe/custom",
      openSystemSettings: async () => {},
      openExternal: async () => {},
      about: () => ({}),
    },
    getLifecycle: () => ({ showSettingsWindow: () => true }),
    applyCodexHomes: async (next, previous) => homes.push([next, previous]),
    validateCodexHome: async (path) => path,
    sendDashboardCommand: () => false,
    setRecurringTimer: () => ({ unref() {} }),
    clearRecurringTimer: () => {},
  });
  await assert.rejects(
    controller.handlers.chooseCodexHome({}),
    (error) => error?.code === "desktop_codex_roots_persistence_failed",
  );
  assert.equal(saves, 1);
  assert.deepEqual(homes, []);
  assert.deepEqual(
    (await store.getCodexHomesForSettings()).activityRoots.map(({ kind }) => kind),
    ["default"],
  );
});

test("unconfirmed login-item changes are not persisted", async () => {
  const value = fixture({
    platformOverrides: {
      setStartAtLogin: () => ({ status: "error", canSet: true, detail: "error" }),
    },
  });
  await assert.rejects(
    value.controller.handlers.setStartAtLogin({ enabled: true }),
    (error) => error?.code === "desktop_start_at_login_unconfirmed",
  );
  assert.equal((await value.store.getSettings()).startAtLogin, false);
});

test("start-at-login persistence failure restores the prior OS state", async () => {
  const calls = [];
  let persisted = false;
  const store = createDesktopSettingsStore({
    backend: {
      load: async () => null,
      save: async () => {
        throw new Error("settings backend unavailable");
      },
    },
  });
  const controller = createDesktopController({
    settingsStore: store,
    platformServices: {
      defaultCodexHomeDisplay: "Default",
      loginItemStatus: () => ({
        status: persisted ? "enabled" : "disabled",
        canSet: true,
        detail: persisted ? "enabled" : "disabled",
      }),
      setStartAtLogin: (enabled) => {
        calls.push(enabled);
        persisted = enabled;
        return {
          status: enabled ? "enabled" : "disabled",
          canSet: true,
          detail: enabled ? "enabled" : "disabled",
        };
      },
      notificationStatus: () => ({ permission: "unavailable", detail: "n/a" }),
      chooseCodexHome: async () => null,
      openSystemSettings: async () => {},
      openExternal: async () => {},
      about: () => ({}),
    },
    getLifecycle: () => ({ showSettingsWindow: () => true }),
    applyCodexHome: async () => {},
    validateCodexHome: async (path) => path,
    sendDashboardCommand: () => false,
    setRecurringTimer: () => ({ unref() {} }),
    clearRecurringTimer: () => {},
  });
  await controller.initialize();
  await assert.rejects(
    controller.handlers.setStartAtLogin({ enabled: true }),
    (error) => error?.code === "desktop_start_at_login_persistence_failed",
  );
  assert.deepEqual(calls, [true, false]);
  assert.equal(persisted, false);
  assert.equal((await store.getSettings()).startAtLogin, false);
});

test("controller keeps multi-root paths main-process-only and orders persistence before apply", async () => {
  const events = [];
  let selectedPath = "/Users/adam/codex-c";
  const value = fixture({
    settingsLoad: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: twoCodexHomes(),
    }),
    settingsSave: async () => { events.push("persist"); },
    platformOverrides: {
      chooseCodexHome: async () => selectedPath,
    },
    actionOverrides: {
      applyCodexHomes: async (next, previous) => {
        events.push("apply");
        assert.equal(next.activityRoots.every((root) => root.enabled === true), true);
        if (previous !== null) assert.equal(typeof previous.primaryRootId, "string");
      },
    },
  });

  await value.controller.initialize();
  assert.deepEqual(events, ["apply"]);
  const generic = await value.controller.handlers.getSettings({});
  assert.doesNotMatch(JSON.stringify(generic), /codex-a|codex-b/u);
  assert.deepEqual(
    (await value.controller.handlers.getCodexHomesForSettings({})).activityRoots
      .map(({ path }) => path),
    ["/Users/adam/codex-a", "/Users/adam/codex-b"],
  );

  await value.controller.handlers.addCodexHome({});
  assert.deepEqual(events.slice(-2), ["persist", "apply"]);
  const afterAdd = await value.controller.handlers.getCodexHomesForSettings({});
  assert.equal(afterAdd.activityRoots.length, 3);

  selectedPath = "/Users/adam/codex-a-edited";
  await value.controller.handlers.editCodexHome({ rootId: ROOT_A });
  await value.controller.handlers.setPrimaryCodexHome({ rootId: ROOT_B });
  const addedRoot = (await value.controller.handlers.getCodexHomesForSettings({})).activityRoots
    .find(({ rootId }) => rootId !== ROOT_A && rootId !== ROOT_B);
  assert.notEqual(addedRoot, undefined);
  await value.controller.handlers.removeCodexHome({ rootId: ROOT_A });
  await value.controller.handlers.reorderCodexHomes({
    rootIds: [addedRoot.rootId, ROOT_B],
  });
  await value.controller.handlers.useDefaultCodexHome({});

  const final = await value.controller.handlers.getCodexHomesForSettings({});
  assert.deepEqual(final, createDefaultCodexHomes());
  assert.equal(events.filter((event) => event === "persist").length, 6);
  assert.equal(events.filter((event) => event === "apply").length, 7);
});

test("controller leaves the persisted multi-root configuration and runtime candidate unchanged on persistence failure", async () => {
  const applyCalls = [];
  const value = fixture({
    settingsSave: async () => { throw new Error("backend unavailable"); },
    actionOverrides: {
      applyCodexHomes: async (...args) => applyCalls.push(args),
    },
  });
  await value.controller.initialize();
  await assert.rejects(
    value.controller.handlers.addCodexHome({}),
    (error) => error?.code === "desktop_codex_roots_persistence_failed",
  );
  assert.equal(applyCalls.length, 1, "a failed write must not restart the companion");
  assert.deepEqual(
    await value.controller.handlers.getCodexHomesForSettings({}),
    createDefaultCodexHomes(),
  );
  assert.doesNotMatch(
    JSON.stringify(await value.controller.handlers.getSettings({})),
    /custom-codex/u,
  );
});

test("controller retains persisted roots and exposes bounded recovery when companion apply fails", async () => {
  const applyCalls = [];
  const value = fixture({
    actionOverrides: {
      applyCodexHomes: async (...args) => {
        applyCalls.push(args);
        if (args[1] !== null) throw new Error("companion restart failed");
      },
    },
  });
  await value.controller.initialize();
  await assert.rejects(
    value.controller.handlers.addCodexHome({}),
    (error) => error?.code === "desktop_codex_roots_apply_failed",
  );
  assert.equal(applyCalls.length, 2);
  const pathful = await value.controller.handlers.getCodexHomesForSettings({});
  assert.equal(pathful.activityRoots.length, 2);
  assert.equal(pathful.activityRoots.at(-1).path, "/Users/adam/custom-codex");
  const snapshot = await value.controller.handlers.getSettings({});
  assert.equal(snapshot.settings.codexFolder.recovery.status, "apply_failed");
  assert.doesNotMatch(JSON.stringify(snapshot), /custom-codex/u);
});

test("controller retains missing configured roots instead of validating or falling back", async () => {
  const validated = [];
  const applied = [];
  const missing = "/Users/adam/missing-codex";
  const value = fixture({
    settingsLoad: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: {
        activityRoots: [{
          rootId: ROOT_A,
          kind: "custom",
          path: missing,
          enabled: true,
        }],
        primaryRootId: ROOT_A,
      },
    }),
    platformOverrides: {
      validateCodexHome: async (path) => {
        validated.push(path);
        throw new Error("missing");
      },
    },
    actionOverrides: {
      applyCodexHomes: async (next) => applied.push(next),
    },
  });
  await value.controller.initialize();
  assert.deepEqual(validated, []);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].activityRoots[0].path, missing);
  assert.equal(
    (await value.controller.handlers.getCodexHomesForSettings({})).activityRoots[0].path,
    missing,
  );
  assert.equal((await value.controller.handlers.getSettings({})).settings.codexFolder.kind, "custom");
});

test("legacy add fallback does not deadlock inside the serialized controller queue", async () => {
  let state = {
    ...DESKTOP_DEFAULT_SETTINGS,
    codexHome: { mode: "default", path: null },
  };
  delete state.codexHomes;
  const legacyStore = {
    async getSettings() { return state; },
    async setLanguage(value) { state = { ...state, language: value }; },
    async setAppearance(value) { state = { ...state, appearance: value }; },
    async setRefreshInterval(value) { state = { ...state, refreshIntervalSeconds: value }; },
    async setStartAtLogin(value) { state = { ...state, startAtLogin: value }; },
    async setNotificationPreferences(value) { state = { ...state, notifications: value }; },
    async setSidebarCollapsed(value) { state = { ...state, sidebarCollapsed: value }; },
    async setCodexHome(value) { state = { ...state, codexHome: value }; },
    async useDefaultCodexHome() { state = { ...state, codexHome: { mode: "default", path: null } }; },
  };
  const value = fixture({ settingsStore: legacyStore });
  await value.controller.initialize();
  let timeout;
  try {
    const result = await Promise.race([
      value.controller.handlers.addCodexHome({}),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("legacy add timed out")), 250);
      }),
    ]);
    assert.equal(result.settings.codexFolder.kind, "custom");
    assert.equal(state.codexHome.mode, "custom");
  } finally {
    clearTimeout(timeout);
  }
});
