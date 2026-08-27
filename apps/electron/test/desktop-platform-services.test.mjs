import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createDesktopPlatformServices,
  validateDesktopCodexHome,
} from "../desktop-platform-services.js";

function directory({ uid = 501, symbolic = false } = {}) {
  return {
    uid,
    isDirectory: () => true,
    isSymbolicLink: () => symbolic,
  };
}

test("Codex home validation canonicalizes a readable owner directory and rejects links", async () => {
  const paths = [];
  const valid = await validateDesktopCodexHome("/Users/adam/.codex", {
    platform: "darwin",
    currentUid: 501,
    lstatPath: async (path) => {
      paths.push(path);
      return directory();
    },
    realpathPath: async () => "/private/Users/adam/.codex",
    accessPath: async (path) => paths.push(path),
  });
  assert.equal(valid, resolve("/private/Users/adam/.codex"));
  assert.deepEqual(paths, [
    "/Users/adam/.codex",
    "/private/Users/adam/.codex",
    "/private/Users/adam/.codex",
  ]);
  await assert.rejects(
    validateDesktopCodexHome("/Users/adam/link", {
      platform: "darwin",
      currentUid: 501,
      lstatPath: async () => directory({ symbolic: true }),
      realpathPath: async () => "/private/target",
      accessPath: async () => {},
    }),
    (error) => error?.code === "desktop_codex_home_invalid",
  );
  await assert.rejects(
    validateDesktopCodexHome("/Users/other/.codex", {
      platform: "darwin",
      currentUid: 501,
      lstatPath: async () => directory({ uid: 502 }),
      realpathPath: async () => "/Users/other/.codex",
      accessPath: async () => {},
    }),
    (error) => error?.code === "desktop_codex_home_not_owned",
  );
});

test("platform services use only native-picker paths and fixed open targets", async () => {
  const opened = [];
  const validated = [];
  const dialogOptions = [];
  const app = {
    isPackaged: true,
    getVersion: () => "0.1.16",
    getLoginItemSettings: () => ({ status: "not-registered", openAtLogin: false }),
    setLoginItemSettings() {},
  };
  const services = createDesktopPlatformServices({
    app,
    platform: "darwin",
    homeDirectory: "/Users/adam",
    environment: { TIBOTATTLE_BUILD_ID: "parity-123" },
    dialog: {
      showOpenDialog: async (options) => {
        dialogOptions.push(options);
        return {
          canceled: false,
          filePaths: ["/Users/adam/custom-codex"],
        };
      },
    },
    shell: {
      openExternal: async (...values) => opened.push(values),
    },
    Notification: { isSupported: () => true },
    validateCodexHome: async (path) => {
      validated.push(path);
      return "/private/Users/adam/custom-codex";
    },
  });
  assert.equal(services.defaultCodexHome, resolve(join("/Users/adam", ".codex")));
  assert.equal(await services.chooseCodexHome(), "/private/Users/adam/custom-codex");
  assert.equal(dialogOptions.at(-1).title, "Choose Codex folder");
  assert.deepEqual(validated, ["/Users/adam/custom-codex"]);
  await services.openExternal("github");
  await services.openSystemSettings("notifications");
  assert.deepEqual(opened, [
    ["https://github.com/adamallcock/tibotattle", { activate: true }],
    ["x-apple.systempreferences:com.apple.Notifications-Settings.extension"],
  ]);
  assert.deepEqual(services.notificationStatus(), {
    permission: "unavailable",
    available: false,
    detail: "Operating-system permission is shown here; local alert capability is reported above.",
  });
  assert.deepEqual(services.about(), {
    version: "0.1.16",
    build: "parity-123",
    update: {
      status: "unavailable",
      canCheck: false,
      detail: "Update checks are unavailable in this development build.",
    },
    automaticUpdates: {
      enabled: false,
      available: false,
      canSet: false,
      detail: "Automatic updates are unavailable in this development build.",
    },
  });
  assert.equal(services.setLocale("es"), true);
  assert.equal(services.defaultCodexHomeDisplay, "Ubicación predeterminada (~/.codex)");
  assert.equal(services.loginItemStatus().detail, "TiboTattle no se iniciará automáticamente.");
  assert.match(services.about().update.detail, /no están disponibles/u);
  await services.chooseCodexHome();
  assert.equal(dialogOptions.at(-1).title, "Elegir carpeta de Codex");
  assert.equal(dialogOptions.at(-1).buttonLabel, "Usar esta carpeta");
  assert.throws(() => services.setLocale("file:///tmp/not-a-language"), /locale is invalid/u);
});

test("login-item state is reread and requires exact confirmation", () => {
  let current = { status: "not-registered", openAtLogin: false };
  const services = createDesktopPlatformServices({
    app: {
      isPackaged: true,
      getVersion: () => "0.1.16",
      getLoginItemSettings: () => current,
      setLoginItemSettings({ openAtLogin }) {
        current = openAtLogin
          ? { status: "requires-approval", openAtLogin: true }
          : { status: "not-registered", openAtLogin: false };
      },
    },
    platform: "darwin",
    homeDirectory: "/Users/adam",
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {} },
    Notification: { isSupported: () => false },
  });
  assert.equal(services.loginItemStatus().status, "disabled");
  assert.equal(services.setStartAtLogin(true).status, "needs-approval");
  assert.equal(services.setStartAtLogin(false).status, "disabled");
});

test("Linux reports unavailable OS-specific settings without pretending support", async () => {
  const services = createDesktopPlatformServices({
    app: { isPackaged: true, getVersion: () => "0.1.16" },
    platform: "linux",
    homeDirectory: "/home/adam",
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {} },
    Notification: { isSupported: () => false },
  });
  assert.deepEqual(services.loginItemStatus(), {
    status: "unavailable",
    canSet: false,
    detail: "Login item status is unavailable. Open your operating system Login Items settings to review it.",
  });
  assert.equal(services.notificationStatus().permission, "unavailable");
  await assert.rejects(
    services.openSystemSettings("startup"),
    (error) => error?.code === "desktop_system_settings_unavailable",
  );
});
