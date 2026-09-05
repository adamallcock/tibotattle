/**
 * Renderer-only settings surface for the Electron shell.
 *
 * The preload owns the implementation of this exact v1 contract. This page
 * deliberately receives no filesystem paths, URLs, IPC handles, or arbitrary
 * commands. Every mutating operation is one of the frozen action names below,
 * and every value is checked against its corresponding finite set before the
 * bridge is called.
 */

import {
  createBrowserLocalization,
  translate,
} from "./localization.js";

export const DESKTOP_SETTINGS_API_VERSION = "v1";

export const SETTINGS_LANGUAGE_VALUES = Object.freeze([
  "system",
  "en",
  "zh-Hans",
  "es",
]);

export const SETTINGS_APPEARANCE_VALUES = Object.freeze([
  "system",
  "light",
  "dark",
]);

export const SETTINGS_REFRESH_INTERVAL_VALUES = Object.freeze([60, 300, 900, 1800]);

export const SETTINGS_NOTIFICATION_THRESHOLD_VALUES = Object.freeze([
  "off",
  "ninety",
  "eighty_and_ninety",
]);

export const SETTINGS_EXTERNAL_TARGETS = Object.freeze({
  website: "https://tibotattle.com",
  github: "https://github.com/adamallcock/tibotattle",
  x: "https://x.com/adamallcock",
});

export const SETTINGS_ACTION_NAMES = Object.freeze([
  "getSettings",
  "getCodexHomesForSettings",
  "openSettings",
  "setLanguage",
  "setAppearance",
  "chooseCodexHome",
  "addCodexHome",
  "editCodexHome",
  "removeCodexHome",
  "setPrimaryCodexHome",
  "reorderCodexHomes",
  "useDefaultCodexHome",
  "setRefreshInterval",
  "setStartAtLogin",
  "setNotificationPreferences",
  "openSystemSettings",
  "checkForUpdates",
  "openExternal",
  "openDashboardInBrowser",
  "showDiagnostics",
  "revealLocalData",
]);

export const SETTINGS_CODEX_ROOT_LIMIT = 8;
export const SETTINGS_CODEX_ROOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const SETTINGS_DEFAULT_CODEX_ROOT_ID =
  "00000000-0000-4000-8000-000000000001";

const LOGIN_ITEM_STATUSES = new Set([
  "enabled",
  "disabled",
  "needs-approval",
  "unavailable",
  "error",
]);

const NOTIFICATION_PERMISSION_STATUSES = new Set([
  "authorized",
  "denied",
  "unknown",
  "unavailable",
]);

const NOTIFICATION_STATES = new Set([
  "uninitialized",
  "ready",
  "state_unavailable",
  "disposed",
]);

const NOTIFICATION_DELIVERY_STATUSES = new Set([
  "not_attempted",
  "ready",
  "delivered",
  "not_packaged",
  "windows_identity_unavailable",
  "unsupported",
  "capability_error",
  "native_error",
  "state_unavailable",
]);

const NOTIFICATION_OUTCOMES = new Set([
  "none",
  "initialized",
  "already_initialized",
  "preferences_updated",
  "preferences_unchanged",
  "disabled",
  "ineligible",
  "first_observation",
  "no_crossing",
  "notification",
  "state_unavailable",
  "status_invalid",
  "disposed",
]);

const NOTIFICATION_REASONS = new Set([
  "none",
  "fresh",
  "stale",
  "inferred",
  "mixed_source",
  "malformed",
  "state_unavailable",
  "status_invalid",
  "disposed",
]);

const UPDATE_STATUSES = new Set([
  "unavailable",
  "checking",
  "available",
  "current",
  "error",
]);

const LOGIN_ITEM_LABELS = Object.freeze({
  enabled: "TiboTattle starts when you sign in.",
  disabled: "TiboTattle will not start automatically.",
  "needs-approval": "Your operating system needs approval in Login Items before this can take effect.",
  unavailable: "Login item status is unavailable. Open your operating system Login Items settings to review it.",
  error: "The operating system did not confirm the current Login Item status. Review it before relying on start at login.",
});

const NOTIFICATION_CAPABILITY_LABELS = Object.freeze({
  ready: "Local allowance alerts are ready.",
  not_packaged: "Local alerts are unavailable in this development build. Use a packaged build with a supported app identity.",
  windows_identity_unavailable: "Local alerts are disabled until this Windows build has a verified app identity.",
  unsupported: "This operating system does not provide the required local notification capability.",
  capability_error: "The operating system could not confirm local alert delivery. Alerts remain disabled.",
  unavailable: "Local allowance alerts are unavailable. No alerts will be sent.",
});

const NOTIFICATION_PERMISSION_MESSAGE_KEYS = Object.freeze({
  authorized: "electron.settings.notifications.permission.authorized",
  denied: "electron.settings.notifications.permission.denied",
  unknown: "electron.settings.notifications.permission.unknown",
  unavailable: "electron.settings.notifications.permission.unavailable",
});

const UPDATE_STATUS_LABELS = Object.freeze({
  unavailable: "Update checks are unavailable in this development build.",
  checking: "Checking the signed update feed…",
  available: "A signed update is available.",
  current: "This is the latest signed build available to this installation.",
  error: "The signed update feed could not be checked. Local analysis is unaffected.",
});

const DESKTOP_TO_BROWSER_LANGUAGE = Object.freeze({
  system: "system",
  en: "en-US",
  "zh-Hans": "zh-Hans",
  es: "es",
});

const LOGIN_STATUS_KEYS = Object.freeze({
  enabled: "electron.settings.login.status.enabled",
  disabled: "electron.settings.login.status.disabled",
  "needs-approval": "electron.settings.login.status.needsApproval",
  unavailable: "electron.settings.login.status.unavailable",
  error: "electron.settings.login.status.error",
});

const UPDATE_STATUS_KEYS = Object.freeze({
  unavailable: "electron.settings.updates.unavailable",
  checking: "electron.settings.updates.checking",
  available: "electron.settings.updates.available",
  current: "electron.settings.updates.current",
  error: "electron.settings.updates.error",
});

function valueIn(values, value) {
  return values.includes(value);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeText(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function validCodexRootId(value) {
  return typeof value === "string" && SETTINGS_CODEX_ROOT_ID_PATTERN.test(value);
}

function validCodexRootDisplayPath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0");
}

function normalizeCodexRoots(value, { includePaths = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Array.isArray(value.activityRoots)
      || value.activityRoots.length < 1
      || value.activityRoots.length > SETTINGS_CODEX_ROOT_LIMIT
      || !validCodexRootId(value.primaryRootId)) {
    return null;
  }
  const roots = [];
  const ids = new Set();
  const customPaths = new Set();
  let defaultCount = 0;
  for (const candidate of value.activityRoots) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
        || !validCodexRootId(candidate.rootId)
        || ids.has(candidate.rootId)
        || (candidate.enabled !== undefined && candidate.enabled !== true)
        || !["default", "custom"].includes(candidate.kind)) {
      return null;
    }
    if (candidate.kind === "default") {
      if (candidate.rootId !== SETTINGS_DEFAULT_CODEX_ROOT_ID || ++defaultCount > 1) {
        return null;
      }
    } else if (candidate.rootId === SETTINGS_DEFAULT_CODEX_ROOT_ID) {
      return null;
    }
    const root = {
      rootId: candidate.rootId,
      kind: candidate.kind,
      enabled: true,
    };
    if (includePaths) {
      if (candidate.kind === "default") {
        root.path = null;
      } else {
        if (!Object.hasOwn(candidate, "path")
            || !validCodexRootDisplayPath(candidate.path)) return null;
        root.path = candidate.path;
        const key = root.path.replaceAll("/", "\\").toLowerCase();
        if (customPaths.has(key)) return null;
        customPaths.add(key);
      }
    }
    ids.add(candidate.rootId);
    roots.push(Object.freeze(root));
  }
  if (!ids.has(value.primaryRootId)) return null;
  return Object.freeze({
    activityRoots: Object.freeze(roots),
    primaryRootId: value.primaryRootId,
  });
}

function defaultCodexRoots() {
  return Object.freeze({
    activityRoots: Object.freeze([Object.freeze({
      rootId: SETTINGS_DEFAULT_CODEX_ROOT_ID,
      kind: "default",
      enabled: true,
    })]),
    primaryRootId: SETTINGS_DEFAULT_CODEX_ROOT_ID,
  });
}

function pathfulCodexRoots(value) {
  return normalizeCodexRoots(value, { includePaths: true });
}

function pathFreeCodexRoots(value) {
  return normalizeCodexRoots(value, { includePaths: false });
}

export function normalizeCodexHomesForSettings(value, { includePaths = false } = {}) {
  return normalizeCodexRoots(value, { includePaths });
}

export function projectCodexHomesForSettings(value) {
  const normalized = pathfulCodexRoots(value);
  return normalized === null ? null : normalized;
}

export function projectCodexHomesPathFree(value) {
  const normalized = pathfulCodexRoots(value) ?? pathFreeCodexRoots(value);
  return normalized === null ? null : pathFreeCodexRoots(normalized);
}

export function normalizeSettingsState(raw, settingsRoots = null) {
  const source = raw && typeof raw === "object" ? raw : {};
  const settings = source.settings && typeof source.settings === "object"
    ? source.settings
    : source;
  const folder = settings.codexFolder && typeof settings.codexFolder === "object"
    ? settings.codexFolder
    : {};
  const startAtLogin = settings.startAtLogin && typeof settings.startAtLogin === "object"
    ? settings.startAtLogin
    : {};
  const notifications = settings.notifications && typeof settings.notifications === "object"
    ? settings.notifications
    : {};
  const about = source.about && typeof source.about === "object"
    ? source.about
    : {};
  const update = about.update && typeof about.update === "object"
    ? about.update
    : source.update && typeof source.update === "object"
      ? source.update
      : {};
  const automaticUpdates = about.automaticUpdates && typeof about.automaticUpdates === "object"
    ? about.automaticUpdates
    : {};
  const rawRoots = settings.codexHomes ?? source.codexHomes;
  const codexHomes = pathFreeCodexRoots(rawRoots) ?? defaultCodexRoots();
  const codexHomesForSettings = settingsRoots === null
    ? pathfulCodexRoots(rawRoots)
    : pathfulCodexRoots(settingsRoots);
  const primaryRoot = codexHomes.activityRoots.find(
    (root) => root.rootId === codexHomes.primaryRootId,
  );

  const language = valueIn(SETTINGS_LANGUAGE_VALUES, settings.language)
    ? settings.language
    : "system";
  const appearance = valueIn(SETTINGS_APPEARANCE_VALUES, settings.appearance)
    ? settings.appearance
    : "system";
  const refreshIntervalSeconds = valueIn(
    SETTINGS_REFRESH_INTERVAL_VALUES,
    finiteNumber(settings.refreshIntervalSeconds, 300),
  )
    ? finiteNumber(settings.refreshIntervalSeconds, 300)
    : 300;
  const folderKind = primaryRoot?.kind ?? (folder.kind === "custom" ? "custom" : "default");
  const loginStatus = LOGIN_ITEM_STATUSES.has(startAtLogin.status)
    ? startAtLogin.status
    : "unavailable";
  const notificationThreshold = valueIn(
    SETTINGS_NOTIFICATION_THRESHOLD_VALUES,
    notifications.threshold,
  )
    ? notifications.threshold
    : "off";
  const notificationState = NOTIFICATION_STATES.has(notifications.state)
    ? notifications.state
    : "state_unavailable";
  const notificationDelivery = NOTIFICATION_DELIVERY_STATUSES.has(notifications.delivery)
    ? notifications.delivery
    : "state_unavailable";
  const notificationOutcome = NOTIFICATION_OUTCOMES.has(notifications.lastOutcome)
    ? notifications.lastOutcome
    : "state_unavailable";
  const notificationReason = NOTIFICATION_REASONS.has(notifications.lastReason)
    ? notifications.lastReason
    : "state_unavailable";
  const notificationLastDelivery = NOTIFICATION_DELIVERY_STATUSES.has(notifications.lastDelivery)
    ? notifications.lastDelivery
    : "state_unavailable";
  const notificationShapeValid = typeof notifications.enabled === "boolean"
    && SETTINGS_NOTIFICATION_THRESHOLD_VALUES.includes(notifications.threshold);
  const notificationCanSet = notificationShapeValid
    && notifications.canSet === true
    && notificationState === "ready"
    && notificationDelivery === "ready";
  const notificationPermission = NOTIFICATION_PERMISSION_STATUSES.has(
    notifications.permission,
  )
    ? notifications.permission
    : "unavailable";
  const updateStatus = UPDATE_STATUSES.has(update.status)
    ? update.status
    : "unavailable";

  return Object.freeze({
    language,
    appearance,
    codexHomes,
    codexHomesForSettings,
    codexFolder: Object.freeze({
      kind: folderKind,
    }),
    refreshIntervalSeconds,
    startAtLogin: Object.freeze({
      status: loginStatus,
      canSet: startAtLogin.canSet === true,
      detail: safeText(startAtLogin.detail, LOGIN_ITEM_LABELS[loginStatus]),
    }),
    notifications: Object.freeze({
      enabled: notificationCanSet && notifications.enabled === true,
      threshold: notificationCanSet ? notificationThreshold : "off",
      canSet: notificationCanSet,
      state: notificationState,
      delivery: notificationDelivery,
      lastOutcome: notificationOutcome,
      lastReason: notificationReason,
      lastDelivery: notificationLastDelivery,
      permission: notificationPermission,
      detail: safeText(
        notifications.detail,
        notificationCanSet
          ? NOTIFICATION_CAPABILITY_LABELS.ready
          : NOTIFICATION_CAPABILITY_LABELS[notificationDelivery]
            ?? NOTIFICATION_CAPABILITY_LABELS.unavailable,
      ),
    }),
    about: Object.freeze({
      version: safeText(about.version, safeText(source.version, "unknown")),
      build: safeText(about.build, safeText(source.build, "unknown")),
      update: Object.freeze({
        status: updateStatus,
        canCheck: update.canCheck === true,
        detail: safeText(update.detail, UPDATE_STATUS_LABELS[updateStatus]),
      }),
      automaticUpdates: Object.freeze({
        enabled: automaticUpdates.enabled === true,
        available: automaticUpdates.available === true,
        canSet: automaticUpdates.canSet === true,
        detail: safeText(
          automaticUpdates.detail,
          automaticUpdates.available === true
            ? "Verified updates can be downloaded automatically."
            : "Automatic updates are unavailable in this build.",
        ),
      }),
    }),
  });
}

function desktopBridge(windowRef) {
  const bridge = windowRef?.tibotattleDesktop;
  if (!bridge || typeof bridge !== "object") return null;
  if (bridge.version !== DESKTOP_SETTINGS_API_VERSION) return null;
  if (typeof bridge.getSettings !== "function") return null;
  return bridge;
}

const SHARING_BASES = new Set([
  "default_on",
  "default_off",
  "migration_default_on",
  "user_choice",
  "legacy_preserved",
]);
const SHARING_STATES = new Set([
  "pending_notices",
  "enabled",
  "disabled",
  "legacy_preserved",
]);
const SHARING_TRANSPORT_STATUSES = new Set(["unavailable", "off"]);

function validSharingTimestamp(value) {
  if (value === null) return true;
  if (typeof value !== "string" || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

export function normalizeElectronSharingPreference(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const available = raw.available === true;
  const current = raw.current === true;
  const state = SHARING_STATES.has(raw.state) ? raw.state : null;
  const basis = SHARING_BASES.has(raw.basis) ? raw.basis : null;
  const noticeCount = Number.isInteger(raw.noticeCount)
    && raw.noticeCount >= 0 && raw.noticeCount <= 3
    ? raw.noticeCount
    : 0;
  const nextNoticeIndex = raw.nextNoticeIndex === null
    ? null
    : Number.isInteger(raw.nextNoticeIndex)
      && raw.nextNoticeIndex >= 1 && raw.nextNoticeIndex <= 3
      ? raw.nextNoticeIndex
      : null;
  if (raw.nextNoticeAt !== undefined && !validSharingTimestamp(raw.nextNoticeAt)) return null;
  if (raw.earliestActivationAt !== undefined && !validSharingTimestamp(raw.earliestActivationAt)) return null;
  if (raw.activatesAt !== undefined && !validSharingTimestamp(raw.activatesAt)) return null;
  const transportStatus = SHARING_TRANSPORT_STATUSES.has(raw.transportStatus)
    ? raw.transportStatus
    : raw.enabled === true ? "unavailable" : "off";
  return Object.freeze({
    available,
    current,
    enabled: available && current && raw.enabled === true,
    state,
    basis,
    noticeCount,
    nextNoticeIndex,
    noticeDue: raw.noticeDue === true,
    nextNoticeAt: validSharingTimestamp(raw.nextNoticeAt) ? raw.nextNoticeAt : null,
    earliestActivationAt: validSharingTimestamp(raw.earliestActivationAt)
      ? raw.earliestActivationAt
      : validSharingTimestamp(raw.activatesAt) ? raw.activatesAt : null,
    transportStatus,
  });
}

function sharingBridge(bridge) {
  return bridge
    && typeof bridge.getSharingPreference === "function"
    && typeof bridge.setSharingEnabled === "function"
    && typeof bridge.sharingNoticePresented === "function"
    ? bridge
    : null;
}

function sharingStateMessageKey(preference) {
  if (!preference?.available || !preference.current) {
    return "electron.sharing.state.unavailable";
  }
  if (preference.state === "pending_notices") return "electron.sharing.state.pending";
  if (preference.enabled && ["default_on", "migration_default_on"].includes(preference.basis)) {
    return "electron.sharing.state.defaultOn";
  }
  if (preference.enabled) return "electron.sharing.state.enabled";
  return preference.state === "legacy_preserved"
    ? "electron.sharing.state.legacy"
    : "electron.sharing.state.off";
}

function sharingTransportMessageKey(preference) {
  switch (preference?.transportStatus) {
    case "off":
      return "electron.sharing.transport.off";
    case "unavailable":
    default:
      return "electron.sharing.transport.unavailable";
  }
}

function fixedActionValue(actionName, value) {
  switch (actionName) {
    case "setLanguage":
      return valueIn(SETTINGS_LANGUAGE_VALUES, value);
    case "setAppearance":
      return valueIn(SETTINGS_APPEARANCE_VALUES, value);
    case "setRefreshInterval":
      return valueIn(SETTINGS_REFRESH_INTERVAL_VALUES, Number(value));
    case "setNotificationPreferences":
      return value && typeof value === "object"
        && typeof value.enabled === "boolean"
        && valueIn(SETTINGS_NOTIFICATION_THRESHOLD_VALUES, value.threshold);
    case "openSystemSettings":
      return value === "startup" || value === "notifications";
    case "openExternal":
      return Object.hasOwn(SETTINGS_EXTERNAL_TARGETS, value);
    case "setStartAtLogin":
      return typeof value === "boolean";
    case "editCodexHome":
    case "removeCodexHome":
    case "setPrimaryCodexHome":
      return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && Reflect.ownKeys(value).length === 1
        && Object.hasOwn(value, "rootId")
        && validCodexRootId(value.rootId);
    case "reorderCodexHomes":
      return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && Reflect.ownKeys(value).length === 1
        && Object.hasOwn(value, "rootIds")
        && Array.isArray(value.rootIds)
        && value.rootIds.length >= 1
        && value.rootIds.length <= SETTINGS_CODEX_ROOT_LIMIT
        && value.rootIds.every((rootId) => validCodexRootId(rootId))
        && new Set(value.rootIds).size === value.rootIds.length;
    default:
      return value === undefined;
  }
}

function queryRequired(documentRef, selector) {
  const element = documentRef?.querySelector?.(selector);
  if (!element) throw new Error(`Missing settings element: ${selector}`);
  return element;
}

function translateSettingsMessage(localizer, key, values = {}) {
  if (typeof localizer?.t === "function") return localizer.t(key, values);
  return translate(key, values, "en-US");
}

function browserLanguagePreference(value) {
  return DESKTOP_TO_BROWSER_LANGUAGE[value] ?? "system";
}

export function applyElectronAppearancePreference(
  preference,
  {
    resolvedTheme = null,
    documentRef = globalThis.document,
    windowRef = globalThis.window,
  } = {},
) {
  if (!SETTINGS_APPEARANCE_VALUES.includes(preference)) return false;
  let theme = resolvedTheme;
  if (!(["light", "dark"].includes(theme))) {
    if (preference === "light" || preference === "dark") {
      theme = preference;
    } else {
      let dark = false;
      try {
        dark = windowRef?.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;
      } catch {
        dark = false;
      }
      theme = dark ? "dark" : "light";
    }
  }
  const root = documentRef?.documentElement;
  if (!root || !["light", "dark"].includes(theme)) return false;
  root.dataset ??= {};
  root.dataset.theme = theme;
  if (root.style) root.style.colorScheme = theme;
  const themeColor = documentRef.querySelector?.('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === "dark" ? "#141a17" : "#f5f1e8";
  return true;
}

function setText(documentRef, selector, value) {
  queryRequired(documentRef, selector).textContent = value;
}

function setOperationStatus(documentRef, value, { error = false } = {}) {
  const element = queryRequired(documentRef, "#settings-operation-status");
  const hasMessage = typeof value === "string" && value.trim() !== "";
  element.textContent = value;
  element.classList?.toggle?.("is-success", hasMessage && !error);
  element.classList?.toggle?.("is-error", hasMessage && error);
}

function setBridgeStatus(documentRef, messageKey, available, localizer) {
  const element = queryRequired(documentRef, "#settings-bridge-status");
  element.textContent = translateSettingsMessage(localizer, messageKey);
  element.classList?.toggle?.("is-ready", available);
  element.classList?.toggle?.("is-unavailable", !available);
}

function notificationCapabilityMessageKey(notifications) {
  if (notifications.canSet === true
      && notifications.state === "ready"
      && notifications.delivery === "ready") {
    return "electron.settings.notifications.status.ready";
  }
  switch (notifications.delivery) {
    case "not_packaged":
      return "electron.settings.notifications.status.developmentUnavailable";
    case "windows_identity_unavailable":
      return "electron.settings.notifications.status.windowsIdentityUnavailable";
    case "unsupported":
      return "electron.settings.notifications.status.unsupported";
    case "capability_error":
    case "native_error":
      return "electron.settings.notifications.status.capabilityError";
    default:
      return "electron.settings.notifications.status.unavailable";
  }
}

function notificationPermissionMessageKey(notifications) {
  return NOTIFICATION_PERMISSION_MESSAGE_KEYS[notifications.permission]
    ?? NOTIFICATION_PERMISSION_MESSAGE_KEYS.unavailable;
}

function createSettingsElement(documentRef, tagName, className = "") {
  if (typeof documentRef?.createElement !== "function") return null;
  const element = documentRef.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function configureRootAction(element, action, rootId, label) {
  element.type = "button";
  element.dataset.rootAction = action;
  element.dataset.rootId = rootId;
  element.setAttribute("aria-label", label);
}

function renderCodexRoots(
  documentRef,
  state,
  bridgeAvailable,
  localizer,
  onAction,
) {
  const list = queryRequired(documentRef, "#settings-codex-roots");
  const status = queryRequired(documentRef, "#settings-codex-roots-status");
  const add = queryRequired(documentRef, "#settings-add-codex-root");
  const useDefault = queryRequired(documentRef, "#settings-use-default-codex-folder");
  const roots = state.codexHomesForSettings?.activityRoots
    ?? state.codexHomes.activityRoots;
  const primaryRootId = state.codexHomesForSettings?.primaryRootId
    ?? state.codexHomes.primaryRootId;
  const detailsAvailable = state.codexHomesForSettings !== null;
  const primaryRoot = roots.find(({ rootId }) => rootId === primaryRootId);
  const defaultRoot = roots.find(({ kind }) => kind === "default");
  const canResetSingleton = roots.length === 1 && primaryRoot?.kind !== "default";
  const canSelectRetainedDefault = roots.length > 1
    && defaultRoot !== undefined
    && defaultRoot.rootId !== primaryRootId;

  // Adding a root would make the single-folder capability claim misleading.
  // A reset is safe for a singleton, and a retained default can safely become
  // primary without changing the saved root records.
  add.hidden = true;
  add.disabled = true;
  useDefault.hidden = false;
  useDefault.disabled = !bridgeAvailable
    || !detailsAvailable
    || (!canResetSingleton && !canSelectRetainedDefault);
  useDefault.setAttribute(
    "title",
    !detailsAvailable
      ? translateSettingsMessage(localizer, "electron.settings.codexRoots.unavailable")
      : roots.length > 1 && defaultRoot === undefined
        ? translateSettingsMessage(localizer, "electron.settings.codexRoots.defaultUnavailable")
        : "",
  );
  status.textContent = !detailsAvailable
    ? translateSettingsMessage(localizer, "electron.settings.codexRoots.unavailable")
    : roots.length > 1 && defaultRoot === undefined
      ? translateSettingsMessage(localizer, "electron.settings.codexRoots.defaultUnavailable")
      : "";
  list.replaceChildren?.();
  if (!detailsAvailable && typeof list.replaceChildren !== "function") {
    list.textContent = "";
  }

  roots.forEach((root, index) => {
    const card = createSettingsElement(documentRef, "article", "settings-root-card");
    const info = createSettingsElement(documentRef, "div");
    const heading = createSettingsElement(documentRef, "h4");
    const location = createSettingsElement(documentRef, "span", "settings-root-path");
    const role = createSettingsElement(documentRef, "div", "settings-root-role");
    const actions = createSettingsElement(documentRef, "div", "settings-root-actions");
    if (!card || !info || !heading || !location || !role || !actions) return;

    const isPrimary = root.rootId === primaryRootId;
    const rootLabel = translateSettingsMessage(
      localizer,
      isPrimary
        ? "electron.settings.codexRoots.rootLabel"
        : "electron.settings.codexRoots.retainedRootLabel",
      { position: index + 1 },
    );
    card.dataset.primary = String(isPrimary);
    card.dataset.analysisScope = isPrimary ? "primary" : "retained";
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-labelledby", `settings-codex-root-${root.rootId}`);
    heading.id = `settings-codex-root-${root.rootId}`;
    heading.textContent = rootLabel;
    location.textContent = root.kind === "default"
      ? translateSettingsMessage(localizer, "electron.settings.codexRoots.defaultPath")
      : (root.path ?? translateSettingsMessage(
        localizer,
        "electron.settings.codexRoots.missingPath",
      ));

    const roleText = createSettingsElement(documentRef, "span");
    if (roleText) {
      roleText.textContent = translateSettingsMessage(
        localizer,
        isPrimary
          ? "electron.settings.codexRoots.primaryHelp"
          : "electron.settings.codexRoots.retained",
      );
      role.append(roleText);
    }

    // A custom primary can be replaced in place, preserving the IDs and
    // paths of every retained v2 root. No secondary action is exposed while
    // only the primary is passed to the companion.
    if (isPrimary && detailsAvailable && (root.kind === "custom" || roots.length === 1)) {
      const edit = createSettingsElement(documentRef, "button", "button button-quiet");
      if (!edit) return;
      const editLabel = translateSettingsMessage(localizer, "electron.settings.codexRoots.edit");
      const action = root.kind === "custom" ? "editCodexHome" : "chooseCodexHome";
      configureRootAction(edit, action, root.rootId, `${editLabel}: ${rootLabel}`);
      edit.textContent = editLabel;
      edit.disabled = !bridgeAvailable;
      edit.addEventListener("click", () => onAction?.(
        action,
        action === "editCodexHome" ? { rootId: root.rootId } : undefined,
      ));
      actions.append(edit);
    }
    info.append(heading, location, role);
    card.append(info);
    if (actions.childNodes?.length > 0) card.append(actions);
    list.append(card);
  });
}

function renderSharingPreference(
  documentRef,
  preference,
  bridgeAvailable,
  localizer,
  { busy = false } = {},
) {
  const enabled = documentRef.querySelector?.("#settings-sharing-enabled");
  const state = documentRef.querySelector?.("#settings-sharing-state");
  const transport = documentRef.querySelector?.("#settings-sharing-transport");
  if (!enabled || !state || !transport) return;
  const usable = bridgeAvailable
    && preference?.available === true
    && preference.current === true;
  enabled.checked = usable && preference.enabled === true;
  enabled.disabled = !usable || busy;
  state.textContent = translateSettingsMessage(
    localizer,
    sharingStateMessageKey(preference),
  );
  transport.textContent = translateSettingsMessage(
    localizer,
    sharingTransportMessageKey(preference),
  );
  state.classList?.toggle?.("is-ready", usable && preference.enabled === true);
  state.classList?.toggle?.("is-unavailable", !usable);
  transport.classList?.toggle?.(
    "is-unavailable",
    !usable || preference.transportStatus === "unavailable",
  );
}

function renderSettingsState(
  documentRef,
  state,
  bridgeAvailable,
  localizer,
  onRootAction,
  sharingPreference = null,
  sharingBridgeAvailable = false,
) {
  const language = queryRequired(documentRef, "#settings-language");
  const appearance = queryRequired(documentRef, "#settings-appearance");
  const folder = queryRequired(documentRef, "#settings-codex-folder-status");
  const refresh = queryRequired(documentRef, "#settings-refresh-interval");
  const loginSwitch = queryRequired(documentRef, "#settings-start-at-login");
  const loginSummary = queryRequired(documentRef, "#settings-start-at-login-summary");
  const notificationsSwitch = queryRequired(documentRef, "#settings-notifications-enabled");
  const notificationDetail = queryRequired(documentRef, "#settings-notifications-detail");
  const thresholdInputs = [...documentRef.querySelectorAll(
    "input[name=\"settings-notification-threshold\"]",
  )];
  const notificationStatus = queryRequired(documentRef, "#settings-notification-status");
  const openNotificationSettings = queryRequired(
    documentRef,
    "#settings-open-notification-settings",
  );
  const automaticSwitch = queryRequired(documentRef, "#settings-automatic-updates");
  const checkForUpdates = queryRequired(documentRef, "#settings-check-for-updates");
  const openDashboardBrowser = queryRequired(
    documentRef,
    "#settings-open-dashboard-browser",
  );
  const showDiagnostics = queryRequired(documentRef, "#settings-show-diagnostics");
  const revealLocalData = queryRequired(documentRef, "#settings-reveal-local-data");

  language.value = state.language;
  appearance.value = state.appearance;
  folder.textContent = state.codexFolder.kind === "default"
    ? translateSettingsMessage(localizer, "electron.settings.codexFolder.default")
    : translateSettingsMessage(localizer, "electron.settings.codexFolder.custom");
  renderCodexRoots(documentRef, state, bridgeAvailable, localizer, onRootAction);
  refresh.value = String(state.refreshIntervalSeconds);
  loginSwitch.checked = state.startAtLogin.status === "enabled";
  loginSwitch.disabled = !bridgeAvailable || !state.startAtLogin.canSet;
  loginSummary.textContent = translateSettingsMessage(
    localizer,
    LOGIN_STATUS_KEYS[state.startAtLogin.status] ?? LOGIN_STATUS_KEYS.unavailable,
  );
  const notificationReady = bridgeAvailable && state.notifications.canSet === true;
  notificationsSwitch.checked = notificationReady && state.notifications.enabled === true;
  notificationsSwitch.disabled = !notificationReady;
  notificationDetail.textContent = translateSettingsMessage(
    localizer,
    notificationCapabilityMessageKey(state.notifications),
  );
  notificationStatus.textContent = translateSettingsMessage(
    localizer,
    notificationPermissionMessageKey(state.notifications),
  );
  const permissionAuthorized = bridgeAvailable
    && state.notifications.permission === "authorized";
  notificationStatus.classList?.toggle?.("is-ready", permissionAuthorized);
  notificationStatus.classList?.toggle?.("is-unavailable", !permissionAuthorized);
  openNotificationSettings.disabled = !notificationReady;
  for (const input of thresholdInputs) {
    input.checked = input.value === state.notifications.threshold;
    input.disabled = !notificationReady;
  }
  automaticSwitch.checked = false;
  automaticSwitch.disabled = true;
  setText(
    documentRef,
    "#settings-version",
    translateSettingsMessage(localizer, "electron.settings.about.version", {
      value: state.about.version,
    }),
  );
  setText(
    documentRef,
    "#settings-build",
    translateSettingsMessage(localizer, "electron.settings.about.build", {
      value: state.about.build,
    }),
  );
  setText(
    documentRef,
    "#settings-updates-status",
    translateSettingsMessage(
      localizer,
      UPDATE_STATUS_KEYS[state.about.update.status] ?? UPDATE_STATUS_KEYS.unavailable,
    ),
  );
  checkForUpdates.disabled = !bridgeAvailable
    || !state.about.update.canCheck
    || state.about.update.status === "checking";
  checkForUpdates.textContent = state.about.update.status === "checking"
    ? translateSettingsMessage(localizer, "electron.settings.updates.checkingButton")
    : translateSettingsMessage(localizer, "electron.settings.updates.check");
  openDashboardBrowser.disabled = !bridgeAvailable;
  showDiagnostics.disabled = !bridgeAvailable;
  revealLocalData.disabled = !bridgeAvailable;
  renderSharingPreference(
    documentRef,
    sharingPreference,
    sharingBridgeAvailable,
    localizer,
  );
}

function setTab(documentRef, tabName, { focus = false } = {}) {
  const tabs = [...documentRef.querySelectorAll("[data-settings-tab]")];
  const panels = [...documentRef.querySelectorAll("[data-settings-panel]")];
  const selected = tabs.find((tab) => tab.dataset.settingsTab === tabName)
    ? tabName
    : "general";
  for (const tab of tabs) {
    const active = tab.dataset.settingsTab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus?.();
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.settingsPanel !== selected;
  }
  return selected;
}

function initialTab(windowRef) {
  const candidate = typeof windowRef?.location?.hash === "string"
    ? windowRef.location.hash.slice(1)
    : "";
  return ["general", "notifications", "about"].includes(candidate)
    ? candidate
    : "general";
}

function operationError(documentRef, localizer) {
  setOperationStatus(
    documentRef,
    translateSettingsMessage(localizer, "electron.settings.operationError"),
    { error: true },
  );
}

function notificationOperationStatus(documentRef, state, localizer) {
  setOperationStatus(
    documentRef,
    translateSettingsMessage(
      localizer,
      state.notifications.enabled
        ? "electron.settings.notifications.operation.enabled"
        : "electron.settings.notifications.operation.disabled",
    ),
  );
}

/**
 * Mounts the settings document. `windowRef` and `documentRef` are injectable
 * so focused tests can exercise keyboard and bridge behavior without a real
 * Electron process.
 */
export async function mountSettingsPage({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  bridge = desktopBridge(windowRef),
  localizer = null,
} = {}) {
  if (!documentRef?.querySelector) return Object.freeze({ teardown() {} });

  const settingsBridge = bridge && bridge.version === DESKTOP_SETTINGS_API_VERSION
    ? bridge
    : null;
  const pageLocalizer = localizer
    ?? (documentRef.querySelector("[data-i18n-root]")
      && typeof documentRef.createElement === "function"
      ? createBrowserLocalization({ windowRef, documentRef })
      : null);
  let currentState = normalizeSettingsState(null);
  applyElectronAppearancePreference(currentState.appearance, { documentRef, windowRef });
  let busy = false;
  const settingsSharingBridge = sharingBridge(settingsBridge);
  let currentSharingPreference = null;
  let sharingBusy = false;
  let invoke = null;
  let unsubscribeDesktopCommands = () => {};
  const listeners = [];
  const listen = (element, type, handler) => {
    element.addEventListener(type, handler);
    listeners.push(() => element.removeEventListener?.(type, handler));
  };

  setBridgeStatus(
    documentRef,
    "electron.settings.bridge.connecting",
    false,
    pageLocalizer,
  );

  if (!settingsBridge) {
    setBridgeStatus(
      documentRef,
      "electron.settings.bridge.unavailable",
      false,
      pageLocalizer,
    );
    renderSettingsState(
      documentRef,
      currentState,
      false,
      pageLocalizer,
      () => {},
      null,
      false,
    );
  }

  const refresh = async () => {
    if (!settingsBridge) return currentState;
    try {
      const next = await settingsBridge.getSettings();
      let rootsForSettings = null;
      if (typeof settingsBridge.getCodexHomesForSettings === "function") {
        try {
          rootsForSettings = await settingsBridge.getCodexHomesForSettings();
        } catch {
          rootsForSettings = undefined;
        }
      }
      currentState = normalizeSettingsState(next, rootsForSettings);
      applyElectronAppearancePreference(currentState.appearance, { documentRef, windowRef });
      pageLocalizer?.setLanguagePreference?.(
        browserLanguagePreference(currentState.language),
        { notifyHost: false, announce: false },
      );
      if (settingsSharingBridge) {
        try {
          currentSharingPreference = normalizeElectronSharingPreference(
            await settingsSharingBridge.getSharingPreference(),
          );
        } catch {
          currentSharingPreference = null;
        }
      } else {
        currentSharingPreference = null;
      }
      renderSettingsState(
        documentRef,
        currentState,
        true,
        pageLocalizer,
        (actionName, value) => { void invoke?.(actionName, value); },
        currentSharingPreference,
        settingsSharingBridge !== null,
      );
      setBridgeStatus(documentRef, "electron.settings.bridge.connected", true, pageLocalizer);
      return currentState;
    } catch {
      currentSharingPreference = null;
      setBridgeStatus(
        documentRef,
        "electron.settings.bridge.readFailed",
        false,
        pageLocalizer,
      );
      renderSettingsState(
        documentRef,
        currentState,
        false,
        pageLocalizer,
        () => {},
        currentSharingPreference,
        settingsSharingBridge !== null,
      );
      return currentState;
    }
  };

  invoke = async (actionName, value) => {
    if (!settingsBridge || busy || !SETTINGS_ACTION_NAMES.includes(actionName)) return;
    if (!fixedActionValue(actionName, value)) {
      operationError(documentRef, pageLocalizer);
      return;
    }
    const action = settingsBridge[actionName];
    if (typeof action !== "function") {
      operationError(documentRef, pageLocalizer);
      return;
    }
    busy = true;
    try {
      const result = value === undefined
        ? await action()
        : await action(value);
      if (result !== undefined
          && (result?.settings !== undefined || result?.language !== undefined)) {
        currentState = normalizeSettingsState(result, currentState.codexHomesForSettings);
      }
      if (actionName === "chooseCodexHome"
          || actionName === "addCodexHome"
          || actionName === "editCodexHome"
          || actionName === "removeCodexHome"
          || actionName === "setPrimaryCodexHome"
          || actionName === "reorderCodexHomes"
          || actionName === "useDefaultCodexHome") {
        // Root mutations return a path-free dashboard snapshot. Re-read the
        // settings-only projection so the newly chosen location is rendered
        // without ever sending it through a renderer mutation argument.
        await refresh();
        return;
      }
      applyElectronAppearancePreference(currentState.appearance, { documentRef, windowRef });
      pageLocalizer?.setLanguagePreference?.(
        browserLanguagePreference(currentState.language),
        { notifyHost: false, announce: false },
      );
      renderSettingsState(
        documentRef,
        currentState,
        true,
        pageLocalizer,
        (nextAction, nextValue) => { void invoke?.(nextAction, nextValue); },
        currentSharingPreference,
        settingsSharingBridge !== null,
      );
      if (actionName === "setNotificationPreferences") {
        notificationOperationStatus(documentRef, currentState, pageLocalizer);
      } else {
        setOperationStatus(documentRef, "");
      }
      setBridgeStatus(documentRef, "electron.settings.bridge.connected", true, pageLocalizer);
    } catch {
      operationError(documentRef, pageLocalizer);
      renderSettingsState(
        documentRef,
        currentState,
        true,
        pageLocalizer,
        (nextAction, nextValue) => { void invoke?.(nextAction, nextValue); },
        currentSharingPreference,
        settingsSharingBridge !== null,
      );
    } finally {
      busy = false;
    }
  };

  const setSharingPreference = async (enabled) => {
    if (!settingsSharingBridge || typeof enabled !== "boolean" || busy || sharingBusy) return;
    sharingBusy = true;
    renderSharingPreference(
      documentRef,
      currentSharingPreference,
      true,
      pageLocalizer,
      { busy: true },
    );
    try {
      const next = normalizeElectronSharingPreference(
        await settingsSharingBridge.setSharingEnabled(enabled),
      );
      if (next === null) throw new Error("Sharing preference response was invalid");
      currentSharingPreference = next;
      setOperationStatus(
        documentRef,
        translateSettingsMessage(pageLocalizer, "electron.settings.sharing.saved"),
      );
    } catch {
      operationError(documentRef, pageLocalizer);
    } finally {
      sharingBusy = false;
      renderSharingPreference(
        documentRef,
        currentSharingPreference,
        true,
        pageLocalizer,
        { busy: false },
      );
    }
  };

  if (settingsBridge && typeof settingsBridge.onCommand === "function") {
    try {
      const unsubscribe = settingsBridge.onCommand((command) => {
        if (command?.command === "appearance"
            && SETTINGS_APPEARANCE_VALUES.includes(command.preference)
            && ["light", "dark"].includes(command.resolvedTheme)) {
          applyElectronAppearancePreference(command.preference, {
            resolvedTheme: command.resolvedTheme,
            documentRef,
            windowRef,
          });
          void refresh();
          return;
        }
        if (command?.command !== "language"
            || !SETTINGS_LANGUAGE_VALUES.includes(command.value)) return;
        pageLocalizer?.setLanguagePreference?.(
          browserLanguagePreference(command.value),
          { notifyHost: false, announce: false },
        );
        void refresh();
      });
      if (typeof unsubscribe === "function") unsubscribeDesktopCommands = unsubscribe;
    } catch {
      // Live synchronization is optional presentation behavior. The explicit
      // refresh action remains available if the preload subscription is not.
    }
  }

  const tabs = [...documentRef.querySelectorAll("[data-settings-tab]")];
  for (const tab of tabs) {
    listen(tab, "click", () => setTab(documentRef, tab.dataset.settingsTab, { focus: true }));
    listen(tab, "keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault?.();
      const index = tabs.indexOf(tab);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setTab(documentRef, tabs[nextIndex].dataset.settingsTab, { focus: true });
    });
  }
  listen(queryRequired(documentRef, "#settings-language"), "change", (event) => {
    pageLocalizer?.setLanguagePreference?.(
      browserLanguagePreference(event.target.value),
      { notifyHost: false },
    );
    void invoke("setLanguage", event.target.value);
  });
  listen(queryRequired(documentRef, "#settings-appearance"), "change", (event) => {
    void invoke("setAppearance", event.target.value);
  });
  listen(queryRequired(documentRef, "#settings-use-default-codex-folder"), "click", () => {
    const roots = currentState.codexHomesForSettings?.activityRoots;
    if (!Array.isArray(roots) || roots.length < 1) return;
    const defaultRoot = roots.find(({ kind }) => kind === "default");
    if (roots.length === 1) {
      void invoke("useDefaultCodexHome");
      return;
    }
    if (defaultRoot?.rootId === currentState.codexHomesForSettings?.primaryRootId) return;
    if (defaultRoot) void invoke("setPrimaryCodexHome", { rootId: defaultRoot.rootId });
  });
  listen(queryRequired(documentRef, "#settings-refresh-interval"), "change", (event) => {
    void invoke("setRefreshInterval", Number(event.target.value));
  });
  listen(queryRequired(documentRef, "#settings-start-at-login"), "change", (event) => {
    void invoke("setStartAtLogin", event.target.checked);
  });
  listen(queryRequired(documentRef, "#settings-open-login-items"), "click", () => {
    void invoke("openSystemSettings", "startup");
  });
  listen(queryRequired(documentRef, "#settings-refresh-login-status"), "click", () => {
    void refresh();
  });
  listen(queryRequired(documentRef, "#settings-notifications-enabled"), "change", (event) => {
    if (!currentState.notifications.canSet) return;
    const enabled = event.target.checked === true;
    const threshold = enabled
      ? (currentState.notifications.threshold === "off" ? "ninety" : currentState.notifications.threshold)
      : "off";
    void invoke("setNotificationPreferences", { enabled, threshold });
  });
  const sharingInput = documentRef.querySelector?.("#settings-sharing-enabled");
  if (sharingInput) {
    listen(sharingInput, "change", (event) => {
      void setSharingPreference(event.target.checked === true);
    });
  }
  for (const input of documentRef.querySelectorAll(
    "input[name=\"settings-notification-threshold\"]",
  )) {
    listen(input, "change", (event) => {
      if (!currentState.notifications.canSet || event.target.checked !== true) return;
      const threshold = event.target.value;
      if (!SETTINGS_NOTIFICATION_THRESHOLD_VALUES.includes(threshold)) return;
      void invoke("setNotificationPreferences", {
        enabled: threshold !== "off",
        threshold,
      });
    });
  }
  listen(queryRequired(documentRef, "#settings-open-notification-settings"), "click", () => {
    void invoke("openSystemSettings", "notifications");
  });
  listen(queryRequired(documentRef, "#settings-check-for-updates"), "click", () => {
    void invoke("checkForUpdates");
  });
  listen(queryRequired(documentRef, "#settings-open-dashboard-browser"), "click", () => {
    void invoke("openDashboardInBrowser");
  });
  listen(queryRequired(documentRef, "#settings-show-diagnostics"), "click", () => {
    void invoke("showDiagnostics");
  });
  listen(queryRequired(documentRef, "#settings-reveal-local-data"), "click", () => {
    void invoke("revealLocalData");
  });
  for (const link of documentRef.querySelectorAll("[data-external-target]")) {
    listen(link, "click", (event) => {
      const target = link.dataset.externalTarget;
      event.preventDefault?.();
      if (!settingsBridge || !fixedActionValue("openExternal", target)) {
        operationError(documentRef, pageLocalizer);
        return;
      }
      void invoke("openExternal", target);
    });
  }

  setTab(documentRef, initialTab(windowRef));
  await refresh();

  return Object.freeze({
    refresh,
    teardown() {
      unsubscribeDesktopCommands();
      for (const remove of listeners.splice(0)) remove();
    },
  });
}

if (typeof document !== "undefined") {
  void mountSettingsPage();
}
