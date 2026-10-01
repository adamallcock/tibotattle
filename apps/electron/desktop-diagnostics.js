import {
  DESKTOP_APPEARANCES,
  DESKTOP_LANGUAGES,
  DESKTOP_REFRESH_INTERVAL_SECONDS,
} from "./desktop-contract.js";

const DIAGNOSTICS_SCHEMA_VERSION = "tibotattle-electron-diagnostics-v2";
const PLATFORMS = new Set(["darwin", "win32", "linux"]);
const ARCHITECTURES = new Set(["arm64", "x64", "ia32", "arm"]);
const LOGIN_STATUSES = new Set([
  "enabled",
  "disabled",
  "needs-approval",
  "unavailable",
  "error",
]);
const NOTIFICATION_DELIVERIES = new Set([
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
const PLATFORM_VALUES = new Set([...PLATFORMS, "unknown"]);
const ARCHITECTURE_VALUES = new Set([...ARCHITECTURES, "unknown"]);
const DIAGNOSTICS_KEYS = Object.freeze([
  "schemaVersion",
  "platform",
  "architecture",
  "version",
  "build",
  "lifecycle",
  "settings",
  "refresh",
  "privacy",
]);
const LIFECYCLE_KEYS = Object.freeze([
  "started",
  "active",
  "dashboardReady",
  "windowVisible",
  "hasTray",
  "recoveryWindowVisible",
  "recoveryStatus",
]);
const SETTINGS_KEYS = Object.freeze([
  "language",
  "appearance",
  "refreshIntervalSeconds",
  "codexFolder",
  "startAtLogin",
  "notificationDelivery",
]);
const PRIVACY_KEYS = Object.freeze([
  "includesPrivateData",
  "includesPaths",
  "includesCredentials",
]);
const REFRESH_KEYS = Object.freeze([
  "schemaVersion",
  "state",
  "mode",
  "cadenceTimerArmed",
  "heartbeatWatchdogArmed",
  "deadlineWatchdogArmed",
  "activeLease",
  "activeLeaseAgeSeconds",
  "lastStartedAt",
  "lastHeartbeatAt",
  "lastSettledAt",
  "lastRecoveredAt",
  "lastRecoveryReason",
]);
const REFRESH_STATES = new Set(["scheduled", "running", "idle", "disposed"]);
const REFRESH_MODES = new Set(["quick", "detailed"]);
const REFRESH_RECOVERY_REASONS = new Set([
  "heartbeat_timeout",
  "operation_deadline",
  "dashboard_replaced",
  "superseded",
]);

function assertExactRecord(value, keys, label) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} has unexpected fields`);
  }
  return value;
}

function assertSafeLabel(value, label) {
  if (typeof value !== "string"
      || !/^[A-Za-z0-9._+-]{1,80}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
}

function validInstant(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertNullableInstant(value, label) {
  if (value !== null && !validInstant(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function strictDiagnosticsRecord(diagnostics) {
  const source = assertExactRecord(diagnostics, DIAGNOSTICS_KEYS, "diagnostics");
  if (source.schemaVersion !== DIAGNOSTICS_SCHEMA_VERSION
      || !PLATFORM_VALUES.has(source.platform)
      || !ARCHITECTURE_VALUES.has(source.architecture)) {
    throw new TypeError("diagnostics identity is invalid");
  }
  assertSafeLabel(source.version, "diagnostics.version");
  assertSafeLabel(source.build, "diagnostics.build");

  const lifecycle = assertExactRecord(source.lifecycle, LIFECYCLE_KEYS, "diagnostics.lifecycle");
  for (const key of LIFECYCLE_KEYS.slice(0, -1)) {
    assertBoolean(lifecycle[key], `diagnostics.lifecycle.${key}`);
  }
  if (lifecycle.recoveryStatus !== null) {
    assertSafeLabel(lifecycle.recoveryStatus, "diagnostics.lifecycle.recoveryStatus");
  }

  const settings = assertExactRecord(source.settings, SETTINGS_KEYS, "diagnostics.settings");
  if (!DESKTOP_LANGUAGES.includes(settings.language)
      || !DESKTOP_APPEARANCES.includes(settings.appearance)
      || !DESKTOP_REFRESH_INTERVAL_SECONDS.includes(settings.refreshIntervalSeconds)
      || !["default", "custom"].includes(settings.codexFolder)
      || !LOGIN_STATUSES.has(settings.startAtLogin)
      || !NOTIFICATION_DELIVERIES.has(settings.notificationDelivery)) {
    throw new TypeError("diagnostics.settings is invalid");
  }

  const refresh = assertExactRecord(source.refresh, REFRESH_KEYS, "diagnostics.refresh");
  if (refresh.schemaVersion !== "tibotattle-desktop-refresh-status-v1"
      || !REFRESH_STATES.has(refresh.state)
      || (refresh.mode !== null && !REFRESH_MODES.has(refresh.mode))
      || (refresh.activeLeaseAgeSeconds !== null
        && (!Number.isSafeInteger(refresh.activeLeaseAgeSeconds)
          || refresh.activeLeaseAgeSeconds < 0))
      || (refresh.lastRecoveryReason !== null
        && !REFRESH_RECOVERY_REASONS.has(refresh.lastRecoveryReason))) {
    throw new TypeError("diagnostics.refresh is invalid");
  }
  for (const key of [
    "cadenceTimerArmed",
    "heartbeatWatchdogArmed",
    "deadlineWatchdogArmed",
    "activeLease",
  ]) {
    assertBoolean(refresh[key], `diagnostics.refresh.${key}`);
  }
  for (const key of [
    "lastStartedAt",
    "lastHeartbeatAt",
    "lastSettledAt",
    "lastRecoveredAt",
  ]) {
    assertNullableInstant(refresh[key], `diagnostics.refresh.${key}`);
  }

  const privacy = assertExactRecord(source.privacy, PRIVACY_KEYS, "diagnostics.privacy");
  for (const key of PRIVACY_KEYS) {
    if (privacy[key] !== false) throw new TypeError("diagnostics privacy is invalid");
  }

  // Reconstruct the complete closed record so JSON.stringify cannot carry
  // inherited, non-enumerable, symbol, or future fields across the support
  // boundary even if a caller hands us a forged object.
  return {
    schemaVersion: source.schemaVersion,
    platform: source.platform,
    architecture: source.architecture,
    version: source.version,
    build: source.build,
    lifecycle: {
      started: lifecycle.started,
      active: lifecycle.active,
      dashboardReady: lifecycle.dashboardReady,
      windowVisible: lifecycle.windowVisible,
      hasTray: lifecycle.hasTray,
      recoveryWindowVisible: lifecycle.recoveryWindowVisible,
      recoveryStatus: lifecycle.recoveryStatus,
    },
    settings: {
      language: settings.language,
      appearance: settings.appearance,
      refreshIntervalSeconds: settings.refreshIntervalSeconds,
      codexFolder: settings.codexFolder,
      startAtLogin: settings.startAtLogin,
      notificationDelivery: settings.notificationDelivery,
    },
    refresh: {
      schemaVersion: refresh.schemaVersion,
      state: refresh.state,
      mode: refresh.mode,
      cadenceTimerArmed: refresh.cadenceTimerArmed,
      heartbeatWatchdogArmed: refresh.heartbeatWatchdogArmed,
      deadlineWatchdogArmed: refresh.deadlineWatchdogArmed,
      activeLease: refresh.activeLease,
      activeLeaseAgeSeconds: refresh.activeLeaseAgeSeconds,
      lastStartedAt: refresh.lastStartedAt,
      lastHeartbeatAt: refresh.lastHeartbeatAt,
      lastSettledAt: refresh.lastSettledAt,
      lastRecoveredAt: refresh.lastRecoveredAt,
      lastRecoveryReason: refresh.lastRecoveryReason,
    },
    privacy: {
      includesPrivateData: false,
      includesPaths: false,
      includesCredentials: false,
    },
  };
}

function safeLabel(value, fallback = "unknown") {
  return typeof value === "string" && /^[A-Za-z0-9._+-]{1,80}$/u.test(value)
    ? value
    : fallback;
}

function safeBoolean(value) {
  return value === true;
}

function safeLifecycleState(value) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return Object.freeze({
    started: safeBoolean(source.started),
    active: safeBoolean(source.active),
    dashboardReady: safeBoolean(source.dashboardReady),
    windowVisible: safeBoolean(source.windowVisible),
    hasTray: safeBoolean(source.hasTray),
    recoveryWindowVisible: safeBoolean(source.recoveryWindowVisible),
    recoveryStatus: typeof source.recoveryStatus === "string"
      ? safeLabel(source.recoveryStatus, "unknown")
      : null,
  });
}

function safeSettingsState(value) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const notifications = source.notifications !== null
    && typeof source.notifications === "object"
    && !Array.isArray(source.notifications)
    ? source.notifications
    : {};
  const startAtLogin = source.startAtLogin !== null
    && typeof source.startAtLogin === "object"
    && !Array.isArray(source.startAtLogin)
    ? source.startAtLogin
    : {};
  return Object.freeze({
    language: DESKTOP_LANGUAGES.includes(source.language) ? source.language : "system",
    appearance: DESKTOP_APPEARANCES.includes(source.appearance)
      ? source.appearance
      : "system",
    refreshIntervalSeconds: DESKTOP_REFRESH_INTERVAL_SECONDS.includes(
      source.refreshIntervalSeconds,
    ) ? source.refreshIntervalSeconds : 300,
    codexFolder: source.codexFolder?.kind === "custom" ? "custom" : "default",
    startAtLogin: LOGIN_STATUSES.has(startAtLogin.status)
      ? startAtLogin.status
      : "unavailable",
    notificationDelivery: NOTIFICATION_DELIVERIES.has(notifications.delivery)
      ? notifications.delivery
      : "state_unavailable",
  });
}

function safeRefreshState(value) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const safeInstant = (candidate) => validInstant(candidate) ? candidate : null;
  return Object.freeze({
    schemaVersion: "tibotattle-desktop-refresh-status-v1",
    state: REFRESH_STATES.has(source.state) ? source.state : "idle",
    mode: REFRESH_MODES.has(source.mode) ? source.mode : null,
    cadenceTimerArmed: safeBoolean(source.cadenceTimerArmed),
    heartbeatWatchdogArmed: safeBoolean(source.heartbeatWatchdogArmed),
    deadlineWatchdogArmed: safeBoolean(source.deadlineWatchdogArmed),
    activeLease: safeBoolean(source.activeLease),
    activeLeaseAgeSeconds: Number.isSafeInteger(source.activeLeaseAgeSeconds)
      && source.activeLeaseAgeSeconds >= 0 ? source.activeLeaseAgeSeconds : null,
    lastStartedAt: safeInstant(source.lastStartedAt),
    lastHeartbeatAt: safeInstant(source.lastHeartbeatAt),
    lastSettledAt: safeInstant(source.lastSettledAt),
    lastRecoveredAt: safeInstant(source.lastRecoveredAt),
    lastRecoveryReason: REFRESH_RECOVERY_REASONS.has(source.lastRecoveryReason)
      ? source.lastRecoveryReason : null,
  });
}

/**
 * Build a deliberately content-free diagnostics record. The inputs are
 * reduced to closed enums and booleans here so a future caller cannot
 * accidentally place a local path, URL, account identifier, or raw error in
 * a diagnostics dialog or clipboard export.
 */
export function createDesktopDiagnostics({
  platform,
  architecture,
  version,
  build,
  lifecycle,
  settings,
  refresh,
} = {}) {
  return Object.freeze({
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    platform: PLATFORMS.has(platform) ? platform : "unknown",
    architecture: ARCHITECTURES.has(architecture) ? architecture : "unknown",
    version: safeLabel(version),
    build: safeLabel(build),
    lifecycle: safeLifecycleState(lifecycle),
    settings: safeSettingsState(settings),
    refresh: safeRefreshState(refresh),
    privacy: Object.freeze({
      includesPrivateData: false,
      includesPaths: false,
      includesCredentials: false,
    }),
  });
}

/** Format only records produced by createDesktopDiagnostics for user support. */
export function formatDesktopDiagnostics(diagnostics) {
  const value = JSON.stringify(strictDiagnosticsRecord(diagnostics), null, 2);
  if (typeof value !== "string" || value.length > 16_384) {
    throw new TypeError("diagnostics record is too large");
  }
  return `${value}\n`;
}

export { DIAGNOSTICS_SCHEMA_VERSION };
