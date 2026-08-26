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
  validateDesktopRequest,
  validateDesktopSettingsSnapshot,
} from "../desktop-contract.js";

test("desktop contract freezes the exact bridge action and enum vocabulary", () => {
  assert.equal(DESKTOP_IPC_CHANNEL, "tibotattle:desktop:v1");
  assert.deepEqual(DESKTOP_ACTIONS, [
    "getSettings",
    "openSettings",
    "chooseCodexHome",
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
  assert.equal(Object.isFrozen(DESKTOP_DEFAULT_SETTINGS.codexHome), true);
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
    "openSettings",
    "chooseCodexHome",
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
    codexHome: { mode: "default", path: null },
    language: "system",
    appearance: "system",
    refreshIntervalSeconds: 300,
    startAtLogin: false,
    notifications: { enabled: false, threshold: "off" },
    sidebarCollapsed: false,
  });

  const valid = validateDesktopSettingsSnapshot({
    ...DESKTOP_DEFAULT_SETTINGS,
    codexHome: { mode: "custom", path: "C:\\Users\\adam\\.codex" },
    language: "zh-Hans",
    appearance: "dark",
    refreshIntervalSeconds: 1800,
    startAtLogin: true,
    notifications: { enabled: true, threshold: "ninety" },
  });
  assert.equal(valid.codexHome.mode, "custom");
  assert.equal(Object.isFrozen(valid.notifications), true);

  assert.equal(
    validateDesktopSettingsSnapshot({
      schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
      codexHome: { mode: "default", path: null },
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
    { ...DESKTOP_DEFAULT_SETTINGS, codexHome: { mode: "default", path: "/tmp" } },
    { ...DESKTOP_DEFAULT_SETTINGS, codexHome: { mode: "custom", path: null } },
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
