import { validateHostedSignInAuthorizeUrl } from "./desktop-hosted-signin.js";

/**
 * Closed contract shared by the Electron main process and its preload.
 *
 * The renderer never receives this module.  It only receives the frozen
 * method surface assembled by the sandboxed preload. Keeping the request vocabulary in
 * one small module gives the main process a single place to validate the
 * structured-clone boundary before dispatching an operation.
 */

export const DESKTOP_BRIDGE_VERSION = "v1";
export const DESKTOP_IPC_CHANNEL = "tibotattle:desktop:v1";
export const DESKTOP_SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v1";

export const DESKTOP_LANGUAGES = Object.freeze([
  "system",
  "en",
  "zh-Hans",
  "es",
]);

export const DESKTOP_REFRESH_INTERVAL_SECONDS = Object.freeze([
  60,
  300,
  900,
  1800,
]);

export const DESKTOP_NOTIFICATION_THRESHOLDS = Object.freeze([
  "off",
  "ninety",
  "eighty_and_ninety",
]);

export const DESKTOP_SYSTEM_SETTINGS_TARGETS = Object.freeze([
  "startup",
  "notifications",
]);

export const DESKTOP_EXTERNAL_TARGETS = Object.freeze([
  "website",
  "github",
  "x",
]);

export const DESKTOP_ACTIONS = Object.freeze([
  "getSettings",
  "openSettings",
  "chooseCodexHome",
  "useDefaultCodexHome",
  "setLanguage",
  "setRefreshInterval",
  "setStartAtLogin",
  "setNotificationPreferences",
  "openSystemSettings",
  "openExternal",
  "openHostedSignIn",
  "checkForUpdates",
  "revealLatestDownload",
]);

const ACTION_ARGUMENT_KEYS = Object.freeze({
  getSettings: Object.freeze([]),
  openSettings: Object.freeze([]),
  chooseCodexHome: Object.freeze([]),
  useDefaultCodexHome: Object.freeze([]),
  setLanguage: Object.freeze(["value"]),
  setRefreshInterval: Object.freeze(["seconds"]),
  setStartAtLogin: Object.freeze(["enabled"]),
  setNotificationPreferences: Object.freeze(["enabled", "threshold"]),
  openSystemSettings: Object.freeze(["target"]),
  openExternal: Object.freeze(["target"]),
  openHostedSignIn: Object.freeze(["authorizeUrl"]),
  checkForUpdates: Object.freeze([]),
  revealLatestDownload: Object.freeze([]),
});

const DEFAULT_CODEX_HOME = Object.freeze({
  mode: "default",
  path: null,
});

const DEFAULT_NOTIFICATIONS = Object.freeze({
  enabled: false,
  threshold: "off",
});

export const DESKTOP_DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
  codexHome: DEFAULT_CODEX_HOME,
  language: "system",
  refreshIntervalSeconds: 300,
  startAtLogin: false,
  notifications: DEFAULT_NOTIFICATIONS,
});

function hasExactKeys(value, expectedKeys) {
  const actualKeys = Reflect.ownKeys(value);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function assertPlainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainRecord(value, label);
  if (!hasExactKeys(value, expectedKeys)) {
    throw new TypeError(`${label} has unexpected keys`);
  }
  return value;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
}

function assertSeconds(value) {
  if (!DESKTOP_REFRESH_INTERVAL_SECONDS.includes(value)) {
    throw new TypeError("seconds is invalid");
  }
  return value;
}

/**
 * Validate and return a frozen request envelope.  The envelope is deliberately
 * `{ action, args }` rather than an open-ended command object: both the action
 * and the exact argument keys are authenticated at the main-process boundary.
 */
export function validateDesktopRequest(request) {
  assertExactKeys(request, ["action", "args"], "request");
  const action = assertEnum(request.action, DESKTOP_ACTIONS, "action");
  const expectedKeys = ACTION_ARGUMENT_KEYS[action];
  const args = assertExactKeys(request.args, expectedKeys, "args");

  switch (action) {
    case "setLanguage":
      assertEnum(args.value, DESKTOP_LANGUAGES, "value");
      break;
    case "setRefreshInterval":
      assertSeconds(args.seconds);
      break;
    case "setStartAtLogin":
      assertBoolean(args.enabled, "enabled");
      break;
    case "setNotificationPreferences":
      assertBoolean(args.enabled, "enabled");
      assertEnum(
        args.threshold,
        DESKTOP_NOTIFICATION_THRESHOLDS,
        "threshold",
      );
      break;
    case "openSystemSettings":
      assertEnum(args.target, DESKTOP_SYSTEM_SETTINGS_TARGETS, "target");
      break;
    case "openExternal":
      assertEnum(args.target, DESKTOP_EXTERNAL_TARGETS, "target");
      break;
    case "openHostedSignIn":
      validateHostedSignInAuthorizeUrl(args.authorizeUrl);
      break;
    default:
      break;
  }

  return Object.freeze({
    action,
    args: Object.freeze({ ...args }),
  });
}

export function createDesktopRequest(action, args = {}) {
  return validateDesktopRequest({ action, args });
}

/**
 * Validate the exact persisted settings schema.  This intentionally does not
 * resolve or inspect paths; path policy belongs to the injected main-process
 * operation that chooses a Codex home.
 */
export function validateDesktopSettingsSnapshot(snapshot) {
  assertExactKeys(
    snapshot,
    [
      "schemaVersion",
      "codexHome",
      "language",
      "refreshIntervalSeconds",
      "startAtLogin",
      "notifications",
    ],
    "settings",
  );
  if (snapshot.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION) {
    throw new TypeError("settings schemaVersion is invalid");
  }

  assertExactKeys(snapshot.codexHome, ["mode", "path"], "codexHome");
  assertEnum(snapshot.codexHome.mode, ["default", "custom"], "codexHome.mode");
  if (snapshot.codexHome.mode === "default") {
    if (snapshot.codexHome.path !== null) {
      throw new TypeError("default codexHome.path must be null");
    }
  } else if (
    typeof snapshot.codexHome.path !== "string"
    || snapshot.codexHome.path.length === 0
    || snapshot.codexHome.path.includes("\0")
  ) {
    throw new TypeError("custom codexHome.path is invalid");
  }

  assertEnum(snapshot.language, DESKTOP_LANGUAGES, "language");
  assertSeconds(snapshot.refreshIntervalSeconds);
  assertBoolean(snapshot.startAtLogin, "startAtLogin");
  assertExactKeys(
    snapshot.notifications,
    ["enabled", "threshold"],
    "notifications",
  );
  assertBoolean(snapshot.notifications.enabled, "notifications.enabled");
  assertEnum(
    snapshot.notifications.threshold,
    DESKTOP_NOTIFICATION_THRESHOLDS,
    "notifications.threshold",
  );

  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    codexHome: Object.freeze({ ...snapshot.codexHome }),
    language: snapshot.language,
    refreshIntervalSeconds: snapshot.refreshIntervalSeconds,
    startAtLogin: snapshot.startAtLogin,
    notifications: Object.freeze({ ...snapshot.notifications }),
  });
}

export const DESKTOP_ACTION_ARGUMENT_KEYS = ACTION_ARGUMENT_KEYS;
