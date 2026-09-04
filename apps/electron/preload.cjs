const { contextBridge, ipcRenderer } = require("electron");

// This preload imports only Electron's limited sandbox-safe bridge APIs; no
// local Node modules are loaded and no renderer-controlled channel is exposed.
// The marker is private to the isolated preload world and exists only for
// diagnostics/tests that need to prove which preload was installed.
const marker = Object.freeze({
  name: "tibotattle-electron-preload",
  version: "v1",
  capabilities: Object.freeze({
    filesystem: false,
    ipc: true,
  }),
});

const IPC_CHANNEL = "tibotattle:desktop:v1";
const COMMAND_CHANNEL = "tibotattle:desktop-command:v1";
const BRIDGE_VERSION = "v1";
const MACOS_SMOKE_CONTROL_ENV = "USAGE_MONITOR_ELECTRON_SMOKE_CONTROL";
const MACOS_SMOKE_CONTROL = "quit-v1";
const MACOS_SMOKE_BRIDGE_NAME = "__TIBOTATTLE_ELECTRON_MACOS_SMOKE__";
const MACOS_SMOKE_BRIDGE_VERSION = "v1";
const WINDOWS_SMOKE_CONTROL = "windows-v1";
const WINDOWS_SMOKE_BRIDGE_NAME = "__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__";
const WINDOWS_SMOKE_BRIDGE_VERSION = "v1";
const WINDOWS_QUALIFICATION_ENV = "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION";
const WINDOWS_QUALIFICATION_MARKER = "windows-electron-v1";
const WINDOWS_TEST_LANE_ENV = "USAGE_MONITOR_TEST_LANE";
const WINDOWS_TEST_LANE = "windows-electron-smoke";
const LANGUAGES = Object.freeze(["system", "en", "zh-Hans", "es"]);
const APPEARANCES = Object.freeze(["system", "light", "dark"]);
const REFRESH_INTERVALS = Object.freeze([60, 300, 900, 1800]);
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const NOTIFICATION_THRESHOLDS = Object.freeze([
  "off",
  "ninety",
  "eighty_and_ninety",
]);
const SYSTEM_SETTINGS_TARGETS = Object.freeze(["startup", "notifications"]);
const EXTERNAL_TARGETS = Object.freeze(["website", "github", "x"]);
const HOSTED_SIGNIN_MAX_LENGTH = 4096;
const HOSTED_SIGNIN_ENDPOINTS = Object.freeze([
  "https://accounts.google.com/o/oauth2/v2/auth",
  "https://appleid.apple.com/auth/authorize",
]);
const HOSTED_SIGNIN_DEFAULT_PORT_ENDPOINTS = Object.freeze([
  "https://accounts.google.com:443/o/oauth2/v2/auth",
  "https://appleid.apple.com:443/auth/authorize",
]);
const CODEX_THREAD_URL_PATTERN =
  /^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODEX_ROOT_LIMIT = 8;
const CODEX_ROOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function rejected(message) {
  return Promise.reject(new TypeError(message));
}

function noArguments(action, values) {
  return values.length === 0
    ? invoke(action, {})
    : rejected(`${action} does not accept arguments`);
}

function oneArgument(action, values, callback) {
  return values.length === 1
    ? callback(values[0])
    : rejected(`${action} requires exactly one argument`);
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  // Renderer arguments cross a realm boundary before they reach this
  // sandboxed preload.  Accept a genuine cross-realm object literal while
  // still rejecting arrays, class instances, and exotic prototypes.
  if (prototype !== null
      && (Object.prototype.toString.call(value) !== "[object Object]"
        || typeof prototype.constructor !== "function"
        || prototype.constructor.name !== "Object")) {
    return false;
  }
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invoke(action, args) {
  if (typeof ipcRenderer?.invoke !== "function") {
    return rejected("desktop IPC is unavailable");
  }
  return ipcRenderer.invoke(IPC_CHANNEL, Object.freeze({
    action,
    args: Object.freeze({ ...args }),
  }));
}

function installTrustedCodexThreadLinkNavigation() {
  const documentRef = globalThis.document;
  if (typeof documentRef?.addEventListener !== "function"
      || typeof ipcRenderer?.invoke !== "function") {
    return;
  }
  // Electron's navigation events do not carry reliable user-gesture proof.
  // Keep the first gate in this isolated preload world, where a page-created
  // click cannot forge `isTrusted`; the main process validates the exact URL,
  // sender, frame, and current dashboard origin again before opening Codex.
  documentRef.addEventListener("click", (event) => {
    if (event?.isTrusted !== true || event.defaultPrevented === true) return;
    const target = event.target;
    const anchor = typeof target?.closest === "function"
      ? target.closest("a[href]")
      : null;
    const href = anchor?.getAttribute?.("href");
    if (typeof href !== "string" || !CODEX_THREAD_URL_PATTERN.test(href)) return;
    event.preventDefault();
    void invoke("openCodexThread", { url: href }).catch(() => {});
  }, true);
}

function enumMethod(action, value, allowed, key = "value") {
  if (!allowed.includes(value)) return rejected(`${key} is invalid`);
  return invoke(action, { [key]: value });
}

function booleanMethod(action, value, key = "enabled") {
  if (typeof value !== "boolean") return rejected(`${key} is invalid`);
  return invoke(action, { [key]: value });
}

function refreshLeaseMethod(action, lease) {
  if (!Number.isSafeInteger(lease) || lease <= 0 || lease > MAX_SAFE_INTEGER) {
    return rejected("lease is invalid");
  }
  return invoke(action, { lease });
}

// Root IDs are the only root values that the renderer may send back. The
// selected folder itself is returned by the main-process picker and never
// crosses this outbound bridge as a mutation argument.
function validCodexRootId(value) {
  return typeof value === "string" && CODEX_ROOT_ID_PATTERN.test(value);
}

function codexRootIdMethod(action, value) {
  if (!exactObject(value, ["rootId"], "root")) {
    return rejected("rootId is invalid");
  }
  if (!validCodexRootId(value.rootId)) return rejected("rootId is invalid");
  return invoke(action, { rootId: value.rootId });
}

function reorderCodexRootsMethod(action, value) {
  if (!exactObject(value, ["rootIds"], "roots")
      || !Array.isArray(value.rootIds)
      || value.rootIds.length < 1
      || value.rootIds.length > CODEX_ROOT_LIMIT
      || value.rootIds.some((rootId) => !validCodexRootId(rootId))
      || new Set(value.rootIds).size !== value.rootIds.length) {
    return rejected("rootIds are invalid");
  }
  return invoke(action, { rootIds: [...value.rootIds] });
}

// This deliberately mirrors the host allowlist without importing a
// Node module into the sandboxed preload. The host parses the string
// again after IPC; this first pass prevents an accidental generic opener from
// being exposed to the renderer at all.
function validHostedSignInAuthorizeUrl(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > HOSTED_SIGNIN_MAX_LENGTH
      || value.includes("\\")
      || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) {
    return false;
  }
  const queryStart = value.indexOf("?");
  if (queryStart <= 0 || queryStart === value.length - 1 || value.includes("#")) {
    return false;
  }
  if (/%(?![0-9A-Fa-f]{2})/u.test(value.slice(queryStart + 1))) return false;
  const endpoint = value.slice(0, queryStart);
  return HOSTED_SIGNIN_ENDPOINTS.includes(endpoint)
    || HOSTED_SIGNIN_DEFAULT_PORT_ENDPOINTS.includes(endpoint);
}

function validDesktopCommand(value) {
  if (value?.command === "refresh") {
    return exactObject(value, ["command"], "command")
      ? Object.freeze({ command: "refresh" })
      : null;
  }
  if (value?.command === "language") {
    return exactObject(value, ["command", "value"], "command")
      && LANGUAGES.includes(value.value)
      ? Object.freeze({ command: "language", value: value.value })
      : null;
  }
  if (value?.command === "sidebar") {
    return exactObject(value, ["command", "collapsed"], "command")
      && typeof value.collapsed === "boolean"
      ? Object.freeze({ command: "sidebar", collapsed: value.collapsed })
      : null;
  }
  if (value?.command === "appearance") {
    return exactObject(value, ["command", "preference", "resolvedTheme"], "command")
      && APPEARANCES.includes(value.preference)
      && (value.resolvedTheme === "light" || value.resolvedTheme === "dark")
      ? Object.freeze({
        command: "appearance",
        preference: value.preference,
        resolvedTheme: value.resolvedTheme,
      })
      : null;
  }
  if (value?.command === "hostedSignInReturn") {
    return exactObject(value, ["command"], "command")
      ? Object.freeze({ command: "hostedSignInReturn" })
      : null;
  }
  if (value?.command === "shareCardDownloadCompleted") {
    return exactObject(value, ["command"], "command")
      ? Object.freeze({ command: "shareCardDownloadCompleted" })
      : null;
  }
  if (value?.command === "shareCardDownloadFailed") {
    return exactObject(value, ["command"], "command")
      ? Object.freeze({ command: "shareCardDownloadFailed" })
      : null;
  }
  return null;
}

function subscribeToDesktopCommands(callback) {
  if (typeof callback !== "function") return rejected("callback is invalid");
  if (typeof ipcRenderer?.on !== "function") return rejected("desktop commands are unavailable");
  let active = true;
  const listener = (_event, rawCommand) => {
    if (!active) return;
    const command = validDesktopCommand(rawCommand);
    if (command === null) return;
    try {
      callback(command);
    } catch {
      // Renderer presentation callbacks cannot affect the preload listener or
      // desktop lifecycle.
    }
  };
  ipcRenderer.on(COMMAND_CHANNEL, listener);
  return function unsubscribeDesktopCommands() {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener?.(COMMAND_CHANNEL, listener);
  };
}

function installDesktopBridge() {
  if (typeof contextBridge?.exposeInMainWorld !== "function") return;
  const bridge = Object.freeze({
    version: BRIDGE_VERSION,
    onCommand: (...values) => oneArgument(
      "onCommand",
      values,
      subscribeToDesktopCommands,
    ),
    getSettings: (...values) => noArguments("getSettings", values),
    getSharingPreference: (...values) => noArguments("getSharingPreference", values),
    setSharingEnabled: (...values) => oneArgument("setSharingEnabled", values,
      (enabled) => booleanMethod("setSharingEnabled", enabled)),
    sharingNoticePresented: (...values) => oneArgument("sharingNoticePresented", values,
      (index) => Number.isInteger(index) && index >= 1 && index <= 3
        ? invoke("sharingNoticePresented", { index })
        : rejected("notice index is invalid")),
    getCodexHomesForSettings: (...values) => noArguments(
      "getCodexHomesForSettings",
      values,
    ),
    openSettings: (...values) => noArguments("openSettings", values),
    toggleSidebar: (...values) => noArguments("toggleSidebar", values),
    chooseCodexHome: (...values) => noArguments("chooseCodexHome", values),
    addCodexHome: (...values) => noArguments("addCodexHome", values),
    editCodexHome: (...values) => oneArgument(
      "editCodexHome",
      values,
      (value) => codexRootIdMethod("editCodexHome", value),
    ),
    removeCodexHome: (...values) => oneArgument(
      "removeCodexHome",
      values,
      (value) => codexRootIdMethod("removeCodexHome", value),
    ),
    setPrimaryCodexHome: (...values) => oneArgument(
      "setPrimaryCodexHome",
      values,
      (value) => codexRootIdMethod("setPrimaryCodexHome", value),
    ),
    reorderCodexHomes: (...values) => oneArgument(
      "reorderCodexHomes",
      values,
      (value) => reorderCodexRootsMethod("reorderCodexHomes", value),
    ),
    useDefaultCodexHome: (...values) => noArguments("useDefaultCodexHome", values),
    setLanguage: (...values) => oneArgument(
      "setLanguage",
      values,
      (value) => enumMethod("setLanguage", value, LANGUAGES),
    ),
    setAppearance: (...values) => oneArgument(
      "setAppearance",
      values,
      (value) => enumMethod("setAppearance", value, APPEARANCES),
    ),
    setRefreshInterval: (...values) => oneArgument(
      "setRefreshInterval",
      values,
      (seconds) => enumMethod(
        "setRefreshInterval",
        seconds,
        REFRESH_INTERVALS,
        "seconds",
      ),
    ),
    setStartAtLogin: (...values) => oneArgument(
      "setStartAtLogin",
      values,
      (enabled) => booleanMethod("setStartAtLogin", enabled),
    ),
    setNotificationPreferences: (...values) => oneArgument(
      "setNotificationPreferences",
      values,
      (preferences) => {
        if (!exactObject(preferences, ["enabled", "threshold"], "preferences")) {
          return rejected("notification preferences are invalid");
        }
        if (typeof preferences.enabled !== "boolean") {
          return rejected("enabled is invalid");
        }
        if (!NOTIFICATION_THRESHOLDS.includes(preferences.threshold)) {
          return rejected("threshold is invalid");
        }
        return invoke("setNotificationPreferences", {
          enabled: preferences.enabled,
          threshold: preferences.threshold,
        });
      },
    ),
    openSystemSettings: (...values) => oneArgument(
      "openSystemSettings",
      values,
      (target) => enumMethod(
        "openSystemSettings",
        target,
        SYSTEM_SETTINGS_TARGETS,
        "target",
      ),
    ),
    openExternal: (...values) => oneArgument(
      "openExternal",
      values,
      (target) => enumMethod(
        "openExternal",
        target,
        EXTERNAL_TARGETS,
        "target",
      ),
    ),
    openHostedSignIn: (...values) => oneArgument(
      "openHostedSignIn",
      values,
      (authorizeUrl) => validHostedSignInAuthorizeUrl(authorizeUrl)
        ? invoke("openHostedSignIn", { authorizeUrl })
        : rejected("authorizeUrl is invalid"),
    ),
    checkForUpdates: (...values) => noArguments("checkForUpdates", values),
    revealLatestDownload: (...values) => noArguments(
      "revealLatestDownload",
      values,
    ),
    openDashboardInBrowser: (...values) => noArguments(
      "openDashboardInBrowser",
      values,
    ),
    showDiagnostics: (...values) => noArguments("showDiagnostics", values),
    revealLocalData: (...values) => noArguments("revealLocalData", values),
    refreshStarted: (...values) => noArguments("refreshStarted", values),
    refreshSettled: (...values) => oneArgument(
      "refreshSettled",
      values,
      (lease) => refreshLeaseMethod("refreshSettled", lease),
    ),
  });
  contextBridge.exposeInMainWorld("tibotattleDesktop", bridge);
}

function installQualifiedSmokeBridge() {
  // Electron's sandboxed preload exposes `process` as a preload binding, but
  // does not guarantee it is an own property of globalThis. Keep the opt-in
  // gate available in that runtime without weakening its platform/control
  // checks or exposing anything to production renderers. Windows uses the
  // same renderer observation barrier, but with its own exact platform,
  // control, and bridge name. The two branches are deliberately explicit so
  // a control intended for one qualification lane can never expose the other
  // lane's bridge.
  const processRef = typeof process !== "undefined" ? process : null;
  const control = processRef?.env?.[MACOS_SMOKE_CONTROL_ENV];
  let bridgeName;
  let bridgeVersion;
  if (processRef?.platform === "darwin" && control === MACOS_SMOKE_CONTROL) {
    bridgeName = MACOS_SMOKE_BRIDGE_NAME;
    bridgeVersion = MACOS_SMOKE_BRIDGE_VERSION;
  } else if (processRef?.platform === "win32"
      && control === WINDOWS_SMOKE_CONTROL
      && processRef?.env?.[WINDOWS_QUALIFICATION_ENV] === WINDOWS_QUALIFICATION_MARKER
      && processRef?.env?.[WINDOWS_TEST_LANE_ENV] === WINDOWS_TEST_LANE) {
    bridgeName = WINDOWS_SMOKE_BRIDGE_NAME;
    bridgeVersion = WINDOWS_SMOKE_BRIDGE_VERSION;
  } else {
    return;
  }
  if (typeof contextBridge?.exposeInMainWorld !== "function") {
    return;
  }
  let resolveStartupRefresh;
  let released = false;
  const startupRefreshGate = new Promise((resolve) => {
    resolveStartupRefresh = resolve;
  });
  const waitForStartupRefresh = (...values) => {
    if (values.length !== 0) {
      throw new TypeError("waitForStartupRefresh does not accept arguments");
    }
    return startupRefreshGate;
  };
  const releaseStartupRefresh = (...values) => {
    if (values.length !== 0) {
      throw new TypeError("releaseStartupRefresh does not accept arguments");
    }
    if (released) return false;
    released = true;
    resolveStartupRefresh?.();
    return true;
  };
  contextBridge.exposeInMainWorld(bridgeName, Object.freeze({
    version: bridgeVersion,
    waitForStartupRefresh,
    releaseStartupRefresh,
  }));
}

function markElectronDashboard() {
  const document = globalThis.document;
  document?.documentElement?.classList?.add?.("electron-dashboard");
  document?.body?.classList?.add?.("electron-dashboard");
}

// Preload runs before the body necessarily exists, so mark the document root
// immediately and repeat exactly once when the body is ready. Electron uses a
// separate marker from the native AppKit dashboard: the web shell must retain
// its own top bar and sidebar inside the cross-platform desktop window.
markElectronDashboard();
globalThis.document?.addEventListener?.(
  "DOMContentLoaded",
  markElectronDashboard,
  { once: true },
);

Object.defineProperty(globalThis, "__TIBOTATTLE_PRELOAD_MARKER__", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: marker,
});

installQualifiedSmokeBridge();
installDesktopBridge();
installTrustedCodexThreadLinkNavigation();
