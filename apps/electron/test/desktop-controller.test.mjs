import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_DEFAULT_SETTINGS } from "../desktop-contract.js";
import { createDesktopController } from "../desktop-controller.js";
import { createDesktopSettingsStore } from "../desktop-settings-store.js";

function fixture({ platformOverrides = {}, lifecycleOverrides = {} } = {}) {
  let persisted = null;
  const store = createDesktopSettingsStore({
    backend: {
      load: async () => null,
      save: async (value) => { persisted = value; },
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
  assert.deepEqual(value.persisted, {
    ...DESKTOP_DEFAULT_SETTINGS,
    codexHome: { mode: "custom", path: "/Users/adam/custom-codex" },
    language: "es",
    refreshIntervalSeconds: 60,
    startAtLogin: true,
    notifications: { enabled: false, threshold: "off" },
  });
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

test("Codex home change rolls back process configuration when persistence fails", async () => {
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
    applyCodexHome: async (next, previous) => homes.push([next, previous]),
    validateCodexHome: async (path) => path,
    sendDashboardCommand: () => false,
    setRecurringTimer: () => ({ unref() {} }),
    clearRecurringTimer: () => {},
  });
  await assert.rejects(
    controller.handlers.chooseCodexHome({}),
    (error) => error?.code === "desktop_codex_home_change_failed",
  );
  assert.equal(saves, 1);
  assert.deepEqual(homes, [
    [
      { mode: "custom", path: "/safe/custom" },
      { mode: "default", path: null },
    ],
    [
      { mode: "default", path: null },
      { mode: "custom", path: "/safe/custom" },
    ],
  ]);
  assert.equal((await store.getSettings()).codexHome.mode, "default");
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
