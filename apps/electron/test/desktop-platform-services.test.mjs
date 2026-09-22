import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createDesktopPlatformServices,
  validateDesktopCodexHome,
} from "../desktop-platform-services.js";
import { LINUX_AUTOSTART_DESKTOP_FILE } from "../linux-autostart.js";

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
  await services.openCodexThread(
    "codex://threads/11111111-1111-4111-8111-111111111111",
  );
  await services.openSystemSettings("notifications");
  assert.deepEqual(opened, [
    ["https://github.com/adamallcock/tibotattle", { activate: true }],
    ["codex://threads/11111111-1111-4111-8111-111111111111", { activate: true }],
    ["x-apple.systempreferences:com.apple.Notifications-Settings.extension"],
  ]);
  for (const value of [
    "codex://threads/not-a-thread",
    "codex://threads/11111111-1111-4111-8111-111111111111?query",
    "codex://user@threads/11111111-1111-4111-8111-111111111111",
  ]) {
    await assert.rejects(
      services.openCodexThread(value),
      (error) => error?.code === "desktop_codex_thread_url_invalid",
    );
  }
  assert.deepEqual(services.notificationStatus(), {
    permission: "unknown",
    available: true,
    detail: "Operating-system permission is shown here; local alert capability is reported above.",
  });
  assert.deepEqual(services.about(), {
    version: "0.1.16",
    build: "parity-123",
    update: {
      status: "unavailable",
      canCheck: false,
      canDownload: false,
      canInstall: false,
      progress: null,
      error: "unavailable",
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
  assert.equal((await services.loginItemStatus()).detail, "TiboTattle no se iniciará automáticamente.");
  assert.match(services.about().update.detail, /no están disponibles/u);
  await services.chooseCodexHome();
  assert.equal(dialogOptions.at(-1).title, "Elegir carpeta de Codex");
  assert.equal(dialogOptions.at(-1).buttonLabel, "Usar esta carpeta");
  assert.throws(() => services.setLocale("file:///tmp/not-a-language"), /locale is invalid/u);
});

test("platform services expose only the bounded updater port and fixed failures", async () => {
  const calls = [];
  let status = {
    automaticDownload: true,
    automaticDownloadAvailable: true,
    canCheck: true,
    canDownload: true,
    canInstall: false,
    error: "none",
    progress: null,
    state: "available",
  };
  const updater = {
    getStatus: () => status,
    checkForUpdates: async () => calls.push("check"),
    downloadUpdate: async () => calls.push("download"),
    installAndRestart: async () => calls.push("install"),
    setAutomaticDownload: async (enabled) => {
      calls.push(["automatic", enabled]);
      status = { ...status, automaticDownload: enabled };
    },
  };
  const services = createDesktopPlatformServices({
    app: { isPackaged: true, getVersion: () => "0.1.18" },
    platform: "darwin",
    homeDirectory: "/Users/adam",
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {} },
    Notification: { isSupported: () => false },
    getUpdater: () => updater,
  });
  await services.checkForUpdates();
  await services.downloadUpdate();
  await services.setAutomaticDownload(false);
  assert.deepEqual(calls, ["check", "download", ["automatic", false]]);
  assert.equal(services.about().update.canDownload, true);
  assert.equal(services.about().automaticUpdates.enabled, false);
  await assert.rejects(
    services.setAutomaticDownload("false"),
    /enabled is required/u,
  );
  updater.downloadUpdate = async () => { throw new Error("network"); };
  await assert.rejects(
    services.downloadUpdate(),
    (error) => error?.code === "desktop_update_download_failed",
  );
});

test("About identifies packaged runtime content when no explicit build label exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-about-runtime-"));
  const manifest = Buffer.from("{\"schemaVersion\":\"usage-monitor-electron-runtime-v0.1\"}\n");
  const environment = {};
  try {
    await writeFile(join(root, "electron-runtime-manifest.json"), manifest);
    const services = createDesktopPlatformServices({
      app: {
        isPackaged: true,
        getVersion: () => "0.1.18",
        getAppPath: () => root,
      },
      platform: "darwin",
      homeDirectory: "/Users/adam",
      environment,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openExternal: async () => {} },
      Notification: { isSupported: () => false },
    });
    const expected = `content-${createHash("sha256").update(manifest).digest("hex").slice(0, 12)}`;
    assert.equal(services.about().build, expected);
    environment.TIBOTATTLE_BUILD_ID = "fixture-build";
    assert.equal(services.about().build, "fixture-build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("About refuses to hash an oversized runtime manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-about-runtime-limit-"));
  try {
    await writeFile(
      join(root, "electron-runtime-manifest.json"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x78),
    );
    const services = createDesktopPlatformServices({
      app: {
        isPackaged: true,
        getVersion: () => "0.1.18",
        getAppPath: () => root,
      },
      platform: "darwin",
      homeDirectory: "/Users/adam",
      environment: {},
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openExternal: async () => {} },
      Notification: { isSupported: () => false },
    });
    assert.equal(services.about().build, "development");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("login-item state is reread and requires exact confirmation", async () => {
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
  assert.equal((await services.loginItemStatus()).status, "disabled");
  assert.equal((await services.setStartAtLogin(true)).status, "needs-approval");
  assert.equal((await services.setStartAtLogin(false)).status, "disabled");
});

test("macOS missing or contradictory login evidence never becomes a disabled preference", async () => {
  let current;
  const calls = [];
  const services = createDesktopPlatformServices({
    app: {
      isPackaged: true,
      getVersion: () => "0.1.20",
      getLoginItemSettings: () => current,
      setLoginItemSettings: (value) => calls.push(value),
    },
    platform: "darwin",
    homeDirectory: "/Users/test",
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {} },
    Notification: { isSupported: () => false },
  });
  for (const [evidence, expected] of [
    [{ status: "not-found", openAtLogin: false }, "unavailable"],
    [{ status: "not-found", openAtLogin: true }, "unavailable"],
    [{ status: "not-registered", openAtLogin: true }, "error"],
    [{ status: "enabled", openAtLogin: false }, "error"],
    [{ status: "unrecognized", openAtLogin: false }, "error"],
    [{ openAtLogin: false }, "error"],
    [{ status: "requires-approval", openAtLogin: false }, "needs-approval"],
  ]) {
    current = evidence;
    const observed = await services.loginItemStatus();
    assert.equal(observed.status, expected);
    assert.equal(observed.canSet, true, "an explicit user action remains available");
    assert.doesNotMatch(observed.detail, /will not start/u);
  }
  assert.deepEqual(calls, [], "status reads must leave OS registration untouched");
  current = { status: "not-found", openAtLogin: false };
  assert.equal((await services.setStartAtLogin(false)).status, "error",
    "an unconfirmed explicit change must not manufacture disabled evidence");
  assert.deepEqual(calls, [{ openAtLogin: false }]);
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
  assert.deepEqual(await services.loginItemStatus(), {
    status: "unavailable",
    canSet: false,
    detail: "Start at login status is unavailable on this system.",
  });
  assert.equal(services.notificationStatus().permission, "unavailable");
  await assert.rejects(
    services.openSystemSettings("startup"),
    (error) => error?.code === "desktop_system_settings_unavailable",
  );
});

test("packaged Linux settings observe and change the exact XDG autostart entry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-login-settings-")));
  const configRoot = join(root, "config");
  const executablePath = join(root, "TiboTattle.AppImage");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(executablePath, 0o700);
  const services = createDesktopPlatformServices({
    app: { isPackaged: true, getVersion: () => "0.1.22" },
    platform: "linux",
    homeDirectory: root,
    environment: { XDG_CONFIG_HOME: configRoot, APPIMAGE: executablePath },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {} },
    Notification: { isSupported: () => false },
  });
  const entry = join(configRoot, "autostart", LINUX_AUTOSTART_DESKTOP_FILE);
  try {
    assert.equal((await services.loginItemStatus()).status, "disabled");
    assert.equal(await readFile(entry, "utf8").catch(() => null), null,
      "status reads must not register autostart");
    assert.equal((await services.setStartAtLogin(true)).status, "enabled");
    assert.match(await readFile(entry, "utf8"), /TiboTattle\.AppImage/u);
    assert.equal((await services.loginItemStatus()).status, "enabled");
    assert.equal((await services.setStartAtLogin(false)).status, "disabled");
    assert.equal(await readFile(entry, "utf8").catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux unsafe startup evidence cannot trigger a replacement or expose a path", async () => {
  let writes = 0;
  const services = createDesktopPlatformServices({
    app: { isPackaged: true, getVersion: () => "0.1.22" },
    platform: "linux",
    homeDirectory: "/home/test",
    linuxAutostartOwner: {
      status: async () => ({ status: "unsafe", canSet: false, path: "/home/test/private" }),
      enable: async () => { writes += 1; },
      disable: async () => { writes += 1; },
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {} },
    Notification: { isSupported: () => false },
  });
  const observed = await services.loginItemStatus();
  assert.equal(observed.status, "unavailable");
  assert.equal(observed.canSet, false);
  assert.equal(JSON.stringify(observed).includes("/home/test/private"), false);
  assert.equal((await services.setStartAtLogin(true)).status, "unavailable");
  assert.equal(writes, 0);
});
