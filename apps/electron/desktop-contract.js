import { validateHostedSignInAuthorizeUrl } from "./desktop-hosted-signin.js";
import { parseCodexThreadURL } from "./loopback-policy.js";
import {
  DESKTOP_CODEX_ROOT_MAX,
  createDefaultCodexHomes,
  isValidCodexRootId,
  migrateLegacyCodexHome,
  normalizeCodexHomes,
  normalizePathFreeCodexHomes,
  projectCodexHomesPathFree,
} from "./desktop-codex-roots.js";

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
export const DESKTOP_SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v2";
export const DESKTOP_LEGACY_SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v1";
export const DESKTOP_LEGACY_LAUNCHER_SETTINGS_SCHEMA_VERSION = "usage-monitor-launcher-settings-v1";
// Internal, non-serialized marker used by the storage adapter to tell the
// store that a legacy record was decoded and must be atomically rewritten as
// v2.  Symbols cannot cross JSON or the renderer bridge.
export const DESKTOP_SETTINGS_LEGACY_MIGRATION_MARKER = Symbol("desktop-settings-legacy-migration");
export const DESKTOP_CODEX_ROOT_LIMIT = DESKTOP_CODEX_ROOT_MAX;

export const DESKTOP_LANGUAGES = Object.freeze([
  "system",
  "en",
  "zh-Hans",
  "es",
]);

// Keep appearance a closed preference.  `system` delegates to the host's
// effective appearance; the other values are the only renderer-visible
// overrides accepted by the Electron shell.
export const DESKTOP_APPEARANCES = Object.freeze([
  "system",
  "light",
  "dark",
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
  "openCodexThread",
  "checkForUpdates",
  "revealLatestDownload",
  "openDashboardInBrowser",
  "showDiagnostics",
  "revealLocalData",
  "refreshStarted",
  "refreshSettled",
]);

const ACTION_ARGUMENT_KEYS = Object.freeze({
  getSettings: Object.freeze([]),
  getCodexHomesForSettings: Object.freeze([]),
  openSettings: Object.freeze([]),
  toggleSidebar: Object.freeze([]),
  chooseCodexHome: Object.freeze([]),
  addCodexHome: Object.freeze([]),
  editCodexHome: Object.freeze(["rootId"]),
  removeCodexHome: Object.freeze(["rootId"]),
  setPrimaryCodexHome: Object.freeze(["rootId"]),
  reorderCodexHomes: Object.freeze(["rootIds"]),
  useDefaultCodexHome: Object.freeze([]),
  setLanguage: Object.freeze(["value"]),
  setAppearance: Object.freeze(["value"]),
  setRefreshInterval: Object.freeze(["seconds"]),
  setStartAtLogin: Object.freeze(["enabled"]),
  setNotificationPreferences: Object.freeze(["enabled", "threshold"]),
  openSystemSettings: Object.freeze(["target"]),
  openExternal: Object.freeze(["target"]),
  openHostedSignIn: Object.freeze(["authorizeUrl"]),
  openCodexThread: Object.freeze(["url"]),
  checkForUpdates: Object.freeze([]),
  revealLatestDownload: Object.freeze([]),
  openDashboardInBrowser: Object.freeze([]),
  showDiagnostics: Object.freeze([]),
  revealLocalData: Object.freeze([]),
  refreshStarted: Object.freeze([]),
  refreshSettled: Object.freeze(["lease"]),
});

const DEFAULT_NOTIFICATIONS = Object.freeze({
  enabled: false,
  threshold: "off",
});

export const DESKTOP_DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
  codexHomes: createDefaultCodexHomes(),
  language: "system",
  appearance: "system",
  refreshIntervalSeconds: 300,
  startAtLogin: false,
  notifications: DEFAULT_NOTIFICATIONS,
  sidebarCollapsed: false,
});

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
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

function assertRefreshLease(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("lease is invalid");
  }
  return value;
}

function assertRootId(value, label) {
  if (!isValidCodexRootId(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertRootIds(value) {
  if (!Array.isArray(value)
      || value.length < 1
      || value.length > DESKTOP_CODEX_ROOT_LIMIT
      || value.some((rootId) => !isValidCodexRootId(rootId))) {
    throw new TypeError("rootIds is invalid");
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
    case "setAppearance":
      assertEnum(args.value, DESKTOP_APPEARANCES, "value");
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
    case "openCodexThread":
      if (parseCodexThreadURL(args.url) === null) {
        throw new TypeError("url is invalid");
      }
      break;
    case "editCodexHome":
    case "removeCodexHome":
    case "setPrimaryCodexHome":
      assertRootId(args.rootId, "rootId");
      break;
    case "reorderCodexHomes":
      assertRootIds(args.rootIds);
      break;
    case "refreshSettled":
      assertRefreshLease(args.lease);
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

const SETTINGS_KEYS = Object.freeze([
  "schemaVersion",
  "codexHomes",
  "language",
  "appearance",
  "refreshIntervalSeconds",
  "startAtLogin",
  "notifications",
  "sidebarCollapsed",
]);

const LEGACY_SETTINGS_BASE_KEYS = Object.freeze([
  "schemaVersion",
  "codexHome",
  "language",
  "refreshIntervalSeconds",
  "startAtLogin",
  "notifications",
]);

const LEGACY_SETTINGS_SCHEMA_VERSIONS = new Set([
  DESKTOP_LEGACY_SETTINGS_SCHEMA_VERSION,
  DESKTOP_LEGACY_LAUNCHER_SETTINGS_SCHEMA_VERSION,
]);

function validateSettingsScalarFields(snapshot) {
  assertEnum(snapshot.language, DESKTOP_LANGUAGES, "language");
  assertEnum(snapshot.appearance, DESKTOP_APPEARANCES, "appearance");
  assertSeconds(snapshot.refreshIntervalSeconds);
  assertBoolean(snapshot.startAtLogin, "startAtLogin");
  assertExactKeys(snapshot.notifications, ["enabled", "threshold"], "notifications");
  assertBoolean(snapshot.notifications.enabled, "notifications.enabled");
  assertEnum(snapshot.notifications.threshold, DESKTOP_NOTIFICATION_THRESHOLDS, "notifications.threshold");
  return snapshot.sidebarCollapsed === undefined
    ? false
    : assertBoolean(snapshot.sidebarCollapsed, "sidebarCollapsed");
}

/**
 * Validate the exact persisted v2 settings schema.  This does not resolve or
 * inspect paths; path policy belongs to the injected main-process picker and
 * platform validator.  A missing custom path therefore remains valid so its
 * configured root can report partial/LKG coverage after reload.
 */
export function validateDesktopSettingsSnapshot(snapshot) {
  assertPlainRecord(snapshot, "settings");
  const preSidebarKeys = SETTINGS_KEYS.slice(0, -1);
  if (!hasExactKeys(snapshot, SETTINGS_KEYS) && !hasExactKeys(snapshot, preSidebarKeys)) {
    throw new TypeError("settings has unexpected keys");
  }
  if (snapshot.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION) {
    throw new TypeError("settings schemaVersion is invalid");
  }
  const codexHomes = normalizeCodexHomes(snapshot.codexHomes);
  const sidebarCollapsed = validateSettingsScalarFields(snapshot);
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    codexHomes,
    language: snapshot.language,
    appearance: snapshot.appearance,
    refreshIntervalSeconds: snapshot.refreshIntervalSeconds,
    startAtLogin: snapshot.startAtLogin,
    notifications: Object.freeze({ ...snapshot.notifications }),
    sidebarCollapsed,
  });
}

/** Validate the generic path-free settings projection returned to a dashboard. */
export function validateDesktopSettingsProjection(snapshot) {
  assertPlainRecord(snapshot, "settings");
  const preSidebarKeys = SETTINGS_KEYS.slice(0, -1);
  if (!hasExactKeys(snapshot, SETTINGS_KEYS) && !hasExactKeys(snapshot, preSidebarKeys)) {
    throw new TypeError("settings has unexpected keys");
  }
  if (snapshot.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION) {
    throw new TypeError("settings schemaVersion is invalid");
  }
  const codexHomes = normalizePathFreeCodexHomes(snapshot.codexHomes);
  const sidebarCollapsed = validateSettingsScalarFields(snapshot);
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    codexHomes,
    language: snapshot.language,
    appearance: snapshot.appearance,
    refreshIntervalSeconds: snapshot.refreshIntervalSeconds,
    startAtLogin: snapshot.startAtLogin,
    notifications: Object.freeze({ ...snapshot.notifications }),
    sidebarCollapsed,
  });
}

/** Return a dashboard-safe copy containing no custom root path values. */
export function projectDesktopSettingsPathFree(snapshot) {
  const validated = validateDesktopSettingsSnapshot(snapshot);
  return validateDesktopSettingsProjection({
    schemaVersion: validated.schemaVersion,
    codexHomes: projectCodexHomesPathFree(validated.codexHomes),
    language: validated.language,
    appearance: validated.appearance,
    refreshIntervalSeconds: validated.refreshIntervalSeconds,
    startAtLogin: validated.startAtLogin,
    notifications: { ...validated.notifications },
    sidebarCollapsed: validated.sidebarCollapsed,
  });
}

export const pathFreeDesktopSettingsProjection = projectDesktopSettingsPathFree;

function isLegacySettingsShape(snapshot) {
  if (!isPlainRecord(snapshot)
      || !LEGACY_SETTINGS_SCHEMA_VERSIONS.has(snapshot.schemaVersion)) {
    return false;
  }
  const actualKeys = Reflect.ownKeys(snapshot);
  if (actualKeys.length === 2
      && Object.hasOwn(snapshot, "schemaVersion")
      && Object.hasOwn(snapshot, "codexHome")) {
    return true;
  }
  const hasAppearance = Object.hasOwn(snapshot, "appearance");
  const hasSidebarCollapsed = Object.hasOwn(snapshot, "sidebarCollapsed");
  const expected = [
    ...LEGACY_SETTINGS_BASE_KEYS,
    ...(hasAppearance ? ["appearance"] : []),
    ...(hasSidebarCollapsed ? ["sidebarCollapsed"] : []),
  ];
  return actualKeys.length === expected.length
    && expected.every((key) => Object.hasOwn(snapshot, key));
}

/**
 * Migrate v1's singleton codexHome record to v2.  `idFactory` is injected by
 * the main process so IDs are opaque and testable; successful store loading
 * persists the result, making the generated ID stable across later reloads.
 * Both the historic Electron object form and the native launcher's scalar
 * path form are accepted for a bounded compatibility window.
 */
export function migrateDesktopSettingsSnapshot(snapshot, { idFactory } = {}) {
  if (!isLegacySettingsShape(snapshot)) return snapshot;
  const codexHomes = migrateLegacyCodexHome(snapshot.codexHome, { idFactory });
  const appearance = snapshot.appearance === undefined
    ? DESKTOP_DEFAULT_SETTINGS.appearance
    : snapshot.appearance;
  const sidebarCollapsed = snapshot.sidebarCollapsed === undefined
    ? false
    : snapshot.sidebarCollapsed;
  return {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    codexHomes,
    language: snapshot.language === undefined
      ? DESKTOP_DEFAULT_SETTINGS.language
      : snapshot.language,
    appearance,
    refreshIntervalSeconds: snapshot.refreshIntervalSeconds === undefined
      ? DESKTOP_DEFAULT_SETTINGS.refreshIntervalSeconds
      : snapshot.refreshIntervalSeconds,
    startAtLogin: snapshot.startAtLogin === undefined
      ? DESKTOP_DEFAULT_SETTINGS.startAtLogin
      : snapshot.startAtLogin,
    notifications: snapshot.notifications === undefined
      ? { ...DESKTOP_DEFAULT_SETTINGS.notifications }
      : { ...snapshot.notifications },
    sidebarCollapsed,
  };
}

/** Migrate a standalone legacy scalar/object codexHome record. */
export function migrateLegacyDesktopSettingsSnapshot(snapshot, options = {}) {
  return migrateDesktopSettingsSnapshot(snapshot, options);
}

export const DESKTOP_ACTION_ARGUMENT_KEYS = ACTION_ARGUMENT_KEYS;
