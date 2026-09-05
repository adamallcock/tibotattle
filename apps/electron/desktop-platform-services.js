import { createHash } from "node:crypto";
import { access, lstat, realpath } from "node:fs/promises";
import {
  closeSync,
  constants as fileSystemConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { DESKTOP_LANGUAGES } from "./desktop-contract.js";
import { desktopText } from "./desktop-menu.js";
import { validateHostedSignInAuthorizeUrl } from "./desktop-hosted-signin.js";
import { parseCodexThreadURL } from "./loopback-policy.js";

const EXTERNAL_URLS = Object.freeze({
  website: "https://tibotattle.com",
  github: "https://github.com/adamallcock/tibotattle",
  x: "https://x.com/adamallcock",
});

const SYSTEM_SETTINGS_URLS = Object.freeze({
  darwin: Object.freeze({
    startup: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
    notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  }),
  win32: Object.freeze({
    startup: "ms-settings:startupapps",
    notifications: "ms-settings:notifications",
  }),
});

function fixedFailure(code) {
  const error = new Error("Desktop platform operation failed");
  error.name = "DesktopPlatformError";
  error.code = code;
  return error;
}

function loginDetail(status, textOptions = {}) {
  if (status === "enabled") return desktopText("electron.settings.login.status.enabled", {}, textOptions);
  if (status === "disabled") return desktopText("electron.settings.login.status.disabled", {}, textOptions);
  if (status === "needs-approval") {
    return desktopText("electron.settings.login.status.needsApproval", {}, textOptions);
  }
  if (status === "error") {
    return desktopText("electron.settings.login.status.error", {}, textOptions);
  }
  return desktopText("electron.settings.login.status.unavailable", {}, textOptions);
}

function notificationDetail(textOptions = {}) {
  return desktopText("electron.settings.notifications.permissionStatus", {}, textOptions);
}

function normalizeMacLoginItem(settings) {
  const status = settings?.status;
  if (status === "requires-approval") return "needs-approval";
  if (status === "enabled" && settings?.openAtLogin === true) return "enabled";
  if (status === "not-registered" || status === "not-found"
      || settings?.openAtLogin === false) return "disabled";
  return "error";
}

function normalizeWindowsLoginItem(settings) {
  if (settings?.openAtLogin === true
      && settings?.executableWillLaunchAtLogin !== false) return "enabled";
  if (settings?.openAtLogin === false) return "disabled";
  return "error";
}

function safeBuildLabel(value) {
  return typeof value === "string" && /^[A-Za-z0-9._+-]{1,80}$/u.test(value)
    ? value
    : "development";
}

// The runtime manifest is already an authenticated, content-addressed record
// of the packaged shell. Read only a small bounded manifest and label its
// digest as content-derived so About never presents it as a source revision.
const MAXIMUM_RUNTIME_MANIFEST_BYTES = 2 * 1024 * 1024;

function packagedRuntimeContentBuild(app) {
  if (typeof app?.getAppPath !== "function") return null;

  let manifestPath;
  try {
    const appPath = app.getAppPath();
    if (typeof appPath !== "string" || !isAbsolute(appPath)) return null;
    manifestPath = join(resolve(appPath), "electron-runtime-manifest.json");
  } catch {
    return null;
  }

  let descriptor = null;
  try {
    descriptor = openSync(manifestPath, fileSystemConstants.O_RDONLY ?? 0);
    const before = fstatSync(descriptor);
    if (!before.isFile()
        || !Number.isSafeInteger(before.size)
        || before.size < 1
        || before.size > MAXIMUM_RUNTIME_MANIFEST_BYTES) {
      return null;
    }

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (!Number.isInteger(count) || count < 1) return null;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.size !== before.size) return null;
    return `content-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The About surface is best effort; a close failure must not prevent
        // the shell from starting or hide the remaining settings controls.
      }
    }
  }
}

function assertDialog(dialog) {
  if (typeof dialog?.showOpenDialog !== "function") {
    throw new TypeError("dialog.showOpenDialog is required");
  }
}

function assertShell(shell) {
  if (typeof shell?.openExternal !== "function") {
    throw new TypeError("shell.openExternal is required");
  }
}

/**
 * Validate a renderer-independent directory selected by Electron's native
 * picker. The canonical path is resolved only in the main process and must be
 * a stable, readable, real directory. POSIX additionally requires current-user
 * ownership; Windows selection is paired with the repository's native state
 * protections for writes, while this path remains a read-only Codex source.
 */
export async function validateDesktopCodexHome(path, {
  platform = process.platform,
  lstatPath = lstat,
  realpathPath = realpath,
  accessPath = access,
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")
      || !isAbsolute(path)) {
    throw fixedFailure("desktop_codex_home_invalid");
  }
  let requested;
  let canonical;
  let resolvedStats;
  try {
    requested = await lstatPath(path);
    if (!requested.isDirectory() || requested.isSymbolicLink()) {
      throw fixedFailure("desktop_codex_home_invalid");
    }
    canonical = await realpathPath(path);
    if (typeof canonical !== "string" || !isAbsolute(canonical)) {
      throw fixedFailure("desktop_codex_home_invalid");
    }
    resolvedStats = await lstatPath(canonical);
    if (!resolvedStats.isDirectory() || resolvedStats.isSymbolicLink()) {
      throw fixedFailure("desktop_codex_home_invalid");
    }
    if (platform !== "win32" && currentUid !== null
        && (requested.uid !== currentUid || resolvedStats.uid !== currentUid)) {
      throw fixedFailure("desktop_codex_home_not_owned");
    }
    await accessPath(canonical, fileSystemConstants.R_OK);
  } catch (error) {
    if (error?.name === "DesktopPlatformError") throw error;
    throw fixedFailure("desktop_codex_home_unavailable");
  }
  return resolve(canonical);
}

/**
 * Main-process-only adapters for native desktop capabilities. Fixed external
 * targets and the canonical Codex thread target are validated here; the native
 * folder picker returns only a canonical directory and renderer input is never
 * interpreted as an arbitrary URL or path.
 */
export function createDesktopPlatformServices({
  app,
  dialog,
  shell,
  Notification,
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
  locale = "system",
  systemLocales,
  validateCodexHome = (path) => validateDesktopCodexHome(path, { platform }),
} = {}) {
  if (!app || typeof app !== "object") throw new TypeError("app is required");
  assertDialog(dialog);
  assertShell(shell);
  if (!["darwin", "win32", "linux"].includes(platform)) {
    throw new TypeError("platform is unsupported");
  }
  if (typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)) {
    throw new TypeError("homeDirectory must be absolute");
  }
  if (typeof validateCodexHome !== "function") {
    throw new TypeError("validateCodexHome is required");
  }

  const defaultCodexHome = resolve(join(homeDirectory, ".codex"));
  const textOptions = { locale, systemLocales };

  function setLocale(value) {
    if (!DESKTOP_LANGUAGES.includes(value)) {
      throw new TypeError("locale is invalid");
    }
    textOptions.locale = value;
    return true;
  }

  function loginItemStatus() {
    const canSet = app.isPackaged === true
      && (platform === "darwin" || platform === "win32")
      && typeof app.getLoginItemSettings === "function"
      && typeof app.setLoginItemSettings === "function";
    if (!canSet) {
      const status = "unavailable";
      return Object.freeze({ status, canSet: false, detail: loginDetail(status, textOptions) });
    }
    try {
      const settings = app.getLoginItemSettings();
      const status = platform === "darwin"
        ? normalizeMacLoginItem(settings)
        : normalizeWindowsLoginItem(settings);
      return Object.freeze({ status, canSet: true, detail: loginDetail(status, textOptions) });
    } catch {
      const status = "error";
      return Object.freeze({ status, canSet: true, detail: loginDetail(status, textOptions) });
    }
  }

  function setStartAtLogin(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled is required");
    const before = loginItemStatus();
    if (!before.canSet) return before;
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch {
      const status = "error";
      return Object.freeze({ status, canSet: true, detail: loginDetail(status, textOptions) });
    }
    const after = loginItemStatus();
    const confirmed = enabled
      ? after.status === "enabled" || after.status === "needs-approval"
      : after.status === "disabled";
    if (confirmed) return after;
    const status = "error";
    return Object.freeze({ status, canSet: true, detail: loginDetail(status, textOptions) });
  }

  function notificationStatus() {
    // The prototype intentionally does not evaluate thresholds or deliver
    // notifications. OS capability is not enough to claim that alerts work.
    const permission = "unavailable";
    return Object.freeze({
      permission,
      available: false,
      detail: notificationDetail(textOptions),
    });
  }

  async function chooseCodexHome() {
    let result;
    try {
      result = await dialog.showOpenDialog({
        title: desktopText("electron.settings.codexFolder.title", {}, textOptions),
        buttonLabel: desktopText("electron.settings.codexFolder.useDefault", {}, textOptions),
        properties: ["openDirectory", "dontAddToRecent"],
      });
    } catch {
      throw fixedFailure("desktop_codex_home_picker_failed");
    }
    if (result?.canceled === true) return null;
    if (!Array.isArray(result?.filePaths) || result.filePaths.length !== 1) {
      throw fixedFailure("desktop_codex_home_picker_failed");
    }
    return validateCodexHome(result.filePaths[0]);
  }

  async function openSystemSettings(target) {
    const selected = SYSTEM_SETTINGS_URLS[platform]?.[target];
    if (typeof selected !== "string") {
      throw fixedFailure("desktop_system_settings_unavailable");
    }
    try {
      await shell.openExternal(selected);
    } catch {
      throw fixedFailure("desktop_system_settings_failed");
    }
    return true;
  }

  async function openExternal(target) {
    const selected = EXTERNAL_URLS[target];
    if (typeof selected !== "string") throw fixedFailure("desktop_external_target_invalid");
    try {
      await shell.openExternal(selected, { activate: true });
    } catch {
      throw fixedFailure("desktop_external_open_failed");
    }
    return true;
  }

  async function openHostedSignIn(authorizeUrl) {
    let selected;
    try {
      // Validate again in the main-process platform adapter. The contract has
      // already checked the IPC envelope, but this keeps the shell safe if a
      // future caller reaches the adapter without that path.
      selected = validateHostedSignInAuthorizeUrl(authorizeUrl);
    } catch {
      throw fixedFailure("desktop_hosted_signin_url_invalid");
    }
    try {
      await shell.openExternal(selected, { activate: true });
    } catch {
      throw fixedFailure("desktop_hosted_signin_open_failed");
    }
    return true;
  }

  async function openCodexThread(url) {
    const selected = parseCodexThreadURL(url);
    if (selected === null) throw fixedFailure("desktop_codex_thread_url_invalid");
    try {
      await shell.openExternal(selected.canonicalURL, { activate: true });
    } catch {
      throw fixedFailure("desktop_codex_thread_open_failed");
    }
    return true;
  }

  function about() {
    const version = typeof app.getVersion === "function"
      ? safeBuildLabel(app.getVersion())
      : "unknown";
    const configuredBuild = environment?.TIBOTATTLE_BUILD_ID;
    const build = typeof configuredBuild === "string" && configuredBuild.length > 0
      ? safeBuildLabel(configuredBuild)
      : packagedRuntimeContentBuild(app) ?? "development";
    return Object.freeze({
      version,
      build,
      update: Object.freeze({
        status: "unavailable",
        canCheck: false,
        detail: desktopText("electron.settings.updates.unavailable", {}, textOptions),
      }),
      automaticUpdates: Object.freeze({
        enabled: false,
        available: false,
        canSet: false,
        detail: desktopText("electron.settings.updates.automaticUnavailable", {}, textOptions),
      }),
    });
  }

  return Object.freeze({
    defaultCodexHome,
    get defaultCodexHomeDisplay() {
      return desktopText("electron.settings.codexFolder.default", {}, textOptions);
    },
    setLocale,
    loginItemStatus,
    setStartAtLogin,
    notificationStatus,
    chooseCodexHome,
    openSystemSettings,
    openExternal,
    openHostedSignIn,
    openCodexThread,
    about,
    checkForUpdates: about,
  });
}

export { EXTERNAL_URLS as DESKTOP_EXTERNAL_URLS, SYSTEM_SETTINGS_URLS as DESKTOP_SYSTEM_SETTINGS_URLS };
