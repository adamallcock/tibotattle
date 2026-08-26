import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_ACTIONS,
  DESKTOP_ACTION_ARGUMENT_KEYS,
  DESKTOP_DEFAULT_SETTINGS,
  DESKTOP_EXTERNAL_TARGETS,
  DESKTOP_IPC_CHANNEL,
  DESKTOP_LANGUAGES,
  DESKTOP_NOTIFICATION_THRESHOLDS,
  DESKTOP_REFRESH_INTERVAL_SECONDS,
  DESKTOP_SETTINGS_SCHEMA_VERSION,
  DESKTOP_SYSTEM_SETTINGS_TARGETS,
  createDesktopRequest,
  migrateDesktopSettingsSnapshot,
  projectDesktopSettingsPathFree,
  validateDesktopRequest,
  validateDesktopSettingsSnapshot,
} from "../desktop-contract.js";

test("desktop contract freezes the exact bridge action and enum vocabulary", () => {
  assert.equal(DESKTOP_IPC_CHANNEL, "tibotattle:desktop:v1");
  assert.deepEqual(DESKTOP_ACTIONS, [
    "getSettings",
    "getCodexHomesForSettings",
    "openSettings",
    "toggleSidebar",
    "chooseCodexHome",
    "addCodexHome",
    "editCodexHome",
    "removeCodexHome",
    "setPrimaryCodexHome",
    "reorderCodexHomes",
    "useDefaultCodexHome",
    "setLanguage",
    "setAppearance",
    "setRefreshInterval",
    "setStartAtLogin",
    "setNotificationPreferences",
    "openSystemSettings",
    "openExternal",
    "openHostedSignIn",
    "checkForUpdates",
    "revealLatestDownload",
    "openDashboardInBrowser",
    "showDiagnostics",
    "revealLocalData",
    "refreshStarted",
    "refreshSettled",
  ]);
  assert.deepEqual(DESKTOP_LANGUAGES, ["system", "en", "zh-Hans", "es"]);
  assert.deepEqual(DESKTOP_REFRESH_INTERVAL_SECONDS, [60, 300, 900, 1800]);
  assert.deepEqual(DESKTOP_NOTIFICATION_THRESHOLDS, [
    "off",
    "ninety",
    "eighty_and_ninety",
  ]);
  assert.deepEqual(DESKTOP_SYSTEM_SETTINGS_TARGETS, ["startup", "notifications"]);
  assert.deepEqual(DESKTOP_EXTERNAL_TARGETS, ["website", "github", "x"]);
  assert.equal(Object.isFrozen(DESKTOP_ACTIONS), true);
  assert.equal(Object.isFrozen(DESKTOP_ACTION_ARGUMENT_KEYS), true);
  assert.equal(Object.isFrozen(DESKTOP_DEFAULT_SETTINGS), true);
  assert.equal(Object.isFrozen(DESKTOP_DEFAULT_SETTINGS.codexHomes), true);
  assert.equal(Object.isFrozen(DESKTOP_DEFAULT_SETTINGS.notifications), true);
});

test("request validation accepts exact envelopes and freezes the result", () => {
  const request = createDesktopRequest("setNotificationPreferences", {
    enabled: true,
    threshold: "eighty_and_ninety",
  });
  assert.deepEqual(request, {
    action: "setNotificationPreferences",
    args: {
      enabled: true,
      threshold: "eighty_and_ninety",
    },
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.args), true);

  for (const action of [
    "getSettings",
    "getCodexHomesForSettings",
    "openSettings",
    "toggleSidebar",
    "chooseCodexHome",
    "addCodexHome",
    "useDefaultCodexHome",
    "checkForUpdates",
    "revealLatestDownload",
    "openDashboardInBrowser",
    "showDiagnostics",
    "revealLocalData",
    "refreshStarted",
  ]) {
    assert.deepEqual(validateDesktopRequest({ action, args: {} }), { action, args: {} });
  }
  assert.deepEqual(
    validateDesktopRequest({ action: "refreshSettled", args: { lease: 1 } }),
    { action: "refreshSettled", args: { lease: 1 } },
  );
  assert.deepEqual(
    validateDesktopRequest({
      action: "openHostedSignIn",
      args: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
      },
    }),
    {
      action: "openHostedSignIn",
      args: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
      },
    },
  );
  for (const action of ["editCodexHome", "removeCodexHome", "setPrimaryCodexHome"]) {
    assert.deepEqual(
      validateDesktopRequest({
        action,
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      }),
      { action, args: { rootId: "11111111-1111-4111-8111-111111111111" } },
    );
  }
  assert.deepEqual(
    validateDesktopRequest({
      action: "reorderCodexHomes",
      args: { rootIds: ["11111111-1111-4111-8111-111111111111"] },
    }),
    {
      action: "reorderCodexHomes",
      args: { rootIds: ["11111111-1111-4111-8111-111111111111"] },
    },
  );
});

test("request validation rejects unknown actions, extra keys, malformed values, and prototypes", () => {
  const invalidRequests = [
    { action: "unknown", args: {} },
    { action: "getSettings", args: { extra: true } },
    { action: "getSettings", args: {}, extra: true },
    { action: "setLanguage", args: { value: "fr" } },
    { action: "setLanguage", args: { value: "en", extra: true } },
    { action: "setRefreshInterval", args: { seconds: 5 } },
    { action: "setStartAtLogin", args: { enabled: "true" } },
    { action: "setNotificationPreferences", args: { enabled: true, threshold: "90" } },
    { action: "refreshSettled", args: {} },
    { action: "refreshSettled", args: { lease: 0 } },
    { action: "refreshSettled", args: { lease: Number.MAX_SAFE_INTEGER + 1 } },
    { action: "refreshSettled", args: { lease: 1, extra: true } },
    { action: "openSystemSettings", args: { target: "arbitrary" } },
    { action: "openExternal", args: { target: "https://evil.example" } },
    { action: "openHostedSignIn", args: { authorizeUrl: "https://evil.example/?x=1" } },
    { action: "openHostedSignIn", args: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth" } },
    { action: "openHostedSignIn", args: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1#fragment" } },
    { action: "editCodexHome", args: { rootId: "root-a" } },
    { action: "removeCodexHome", args: { rootId: "11111111-1111-4111-8111-111111111111", extra: true } },
    { action: "reorderCodexHomes", args: { rootIds: [] } },
    { action: "openExternal", args: Object.assign(Object.create(null), {
      target: "github",
      extra: "reject",
    }) },
    { action: "getSettings", args: Object.create(null) },
    { action: "getSettings", args: [] },
    null,
  ];
  for (const value of invalidRequests) {
    assert.throws(() => validateDesktopRequest(value), TypeError, JSON.stringify(value));
  }
});

test("settings snapshot validator enforces the exact schema and defaults", () => {
  assert.deepEqual(validateDesktopSettingsSnapshot(DESKTOP_DEFAULT_SETTINGS), {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    codexHomes: {
      activityRoots: [{
        rootId: "00000000-0000-4000-8000-000000000001",
        kind: "default",
        path: null,
        enabled: true,
      }],
      primaryRootId: "00000000-0000-4000-8000-000000000001",
    },
    language: "system",
    appearance: "system",
    refreshIntervalSeconds: 300,
    startAtLogin: false,
    notifications: { enabled: false, threshold: "off" },
    sidebarCollapsed: false,
  });

  const valid = validateDesktopSettingsSnapshot({
    ...DESKTOP_DEFAULT_SETTINGS,
    codexHomes: {
      activityRoots: [{
        rootId: "11111111-1111-4111-8111-111111111111",
        kind: "custom",
        path: "C:\\Users\\adam\\.codex",
        enabled: true,
      }],
      primaryRootId: "11111111-1111-4111-8111-111111111111",
    },
    language: "zh-Hans",
    appearance: "dark",
    refreshIntervalSeconds: 1800,
    startAtLogin: true,
    notifications: { enabled: true, threshold: "ninety" },
  });
  assert.equal(valid.codexHomes.activityRoots[0].kind, "custom");
  assert.equal(Object.isFrozen(valid.notifications), true);

  assert.equal(
    validateDesktopSettingsSnapshot({
      schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
      codexHomes: DESKTOP_DEFAULT_SETTINGS.codexHomes,
      language: "system",
      appearance: "system",
      refreshIntervalSeconds: 300,
      startAtLogin: false,
      notifications: { enabled: false, threshold: "off" },
    }).sidebarCollapsed,
    false,
  );

  for (const invalid of [
    { ...DESKTOP_DEFAULT_SETTINGS, schemaVersion: "v2" },
    { ...DESKTOP_DEFAULT_SETTINGS, extra: true },
    { ...DESKTOP_DEFAULT_SETTINGS, codexHomes: {
      activityRoots: [{
        rootId: "00000000-0000-4000-8000-000000000001",
        kind: "default",
        path: "/tmp",
        enabled: true,
      }],
      primaryRootId: "00000000-0000-4000-8000-000000000001",
    } },
    { ...DESKTOP_DEFAULT_SETTINGS, codexHomes: {
      activityRoots: [{
        rootId: "11111111-1111-4111-8111-111111111111",
        kind: "custom",
        path: null,
        enabled: true,
      }],
      primaryRootId: "11111111-1111-4111-8111-111111111111",
    } },
    { ...DESKTOP_DEFAULT_SETTINGS, language: "fr" },
    { ...DESKTOP_DEFAULT_SETTINGS, appearance: "sepia" },
    { ...DESKTOP_DEFAULT_SETTINGS, refreshIntervalSeconds: 1 },
    { ...DESKTOP_DEFAULT_SETTINGS, startAtLogin: 1 },
    { ...DESKTOP_DEFAULT_SETTINGS, notifications: { enabled: false, threshold: "90" } },
    { ...DESKTOP_DEFAULT_SETTINGS, sidebarCollapsed: "false" },
  ]) {
    assert.throws(() => validateDesktopSettingsSnapshot(invalid), TypeError);
  }
});

test("v1 scalar migration creates one stable v2 root and path-free projection", () => {
  const legacy = {
    schemaVersion: "tibotattle-desktop-settings-v1",
    codexHome: { mode: "custom", path: "C:\\Users\\adam\\.codex" },
    language: "en",
    appearance: "light",
    refreshIntervalSeconds: 900,
    startAtLogin: true,
    notifications: { enabled: false, threshold: "off" },
  };
  const migrated = migrateDesktopSettingsSnapshot(legacy, {
    idFactory: () => "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(migrated.schemaVersion, DESKTOP_SETTINGS_SCHEMA_VERSION);
  assert.equal(migrated.codexHomes.activityRoots[0].rootId, "11111111-1111-4111-8111-111111111111");
  const projected = projectDesktopSettingsPathFree(migrated);
  assert.equal(Object.hasOwn(projected.codexHomes.activityRoots[0], "path"), false);
  assert.equal(JSON.stringify(projected).includes("Users"), false);

  const scalar = migrateDesktopSettingsSnapshot({
    schemaVersion: "usage-monitor-launcher-settings-v1",
    codexHome: "/Users/adam/.codex",
  });
  assert.equal(scalar.schemaVersion, DESKTOP_SETTINGS_SCHEMA_VERSION);
  assert.equal(scalar.language, "system");
  assert.equal(scalar.codexHomes.activityRoots[0].kind, "custom");
});
