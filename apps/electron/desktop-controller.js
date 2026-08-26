import { DESKTOP_ACTIONS, DESKTOP_APPEARANCES } from "./desktop-contract.js";
import { createDesktopCommand } from "./desktop-command.js";
import { desktopText } from "./desktop-copy.js";

const DASHBOARD_COMMANDS = Object.freeze({
  refresh: Object.freeze({ command: "refresh" }),
});

// The renderer keeps one immutable 121-minute operation deadline. This small
// additional margin releases a lease after a crashed/replaced renderer while
// still allowing a legitimate cold index pass to settle first.
export const DESKTOP_REFRESH_LEASE_WATCHDOG_MS = 123 * 60_000;

const NOTIFICATION_THRESHOLDS = Object.freeze([
  "off",
  "ninety",
  "eighty_and_ninety",
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

const UNAVAILABLE_NOTIFICATION_STATUS = Object.freeze({
  state: "state_unavailable",
  enabled: false,
  threshold: "off",
  resetEnabled: false,
  delivery: "state_unavailable",
  lastOutcome: "state_unavailable",
  lastReason: "state_unavailable",
  lastDelivery: "state_unavailable",
});

function createUnavailableNotificationCoordinator() {
  const status = () => UNAVAILABLE_NOTIFICATION_STATUS;
  return Object.freeze({
    async initialize() {
      return Object.freeze({
        outcome: "state_unavailable",
        reason: "state_unavailable",
        delivery: "state_unavailable",
        status: status(),
      });
    },
    status,
    async setPreferences() {
      return Object.freeze({
        outcome: "state_unavailable",
        reason: "state_unavailable",
        delivery: "state_unavailable",
        status: status(),
      });
    },
  });
}

function controllerError(code) {
  const error = new Error("Desktop controller operation failed");
  error.name = "DesktopControllerError";
  error.code = code;
  return error;
}

function assertPort(value, methodNames, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is required`);
  }
  for (const method of methodNames) {
    if (typeof value[method] !== "function") {
      throw new TypeError(`${label}.${method} is required`);
    }
  }
  return value;
}

function cloneHome(home) {
  return Object.freeze({ mode: home.mode, path: home.path });
}

function loginItemChangeAccepted(result, enabled) {
  return enabled
    ? result?.status === "enabled" || result?.status === "needs-approval"
    : result?.status === "disabled";
}

function safeNotificationStatus(value) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const state = NOTIFICATION_STATES.has(source.state)
    ? source.state
    : "state_unavailable";
  const delivery = NOTIFICATION_DELIVERY_STATUSES.has(source.delivery)
    ? source.delivery
    : "state_unavailable";
  const ready = state === "ready" && delivery === "ready";
  return Object.freeze({
    state,
    enabled: ready && source.enabled === true,
    threshold: ready && NOTIFICATION_THRESHOLDS.includes(source.threshold)
      ? source.threshold
      : "off",
    resetEnabled: ready && source.resetEnabled === true,
    delivery,
    lastOutcome: NOTIFICATION_OUTCOMES.has(source.lastOutcome)
      ? source.lastOutcome
      : "state_unavailable",
    lastReason: NOTIFICATION_REASONS.has(source.lastReason)
      ? source.lastReason
      : "state_unavailable",
    lastDelivery: NOTIFICATION_DELIVERY_STATUSES.has(source.lastDelivery)
      ? source.lastDelivery
      : "state_unavailable",
  });
}

function notificationCapability(status) {
  return status.state === "ready" && status.delivery === "ready";
}

function notificationDetailKey(status) {
  if (notificationCapability(status)) return "electron.settings.notifications.status.ready";
  switch (status.delivery) {
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

function fixedNotificationPreferences(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw controllerError("desktop_notifications_invalid");
  }
  if (typeof value.enabled !== "boolean"
      || !NOTIFICATION_THRESHOLDS.includes(value.threshold)) {
    throw controllerError("desktop_notifications_invalid");
  }
  return Object.freeze({
    enabled: value.enabled,
    threshold: value.threshold,
  });
}

/**
 * Coordinates the exact desktop bridge actions without giving any renderer a
 * generic command, path, or URL primitive. Settings persistence, OS services,
 * companion reconfiguration, and dashboard commands are all explicit ports so
 * their failure/rollback behavior remains plain-Node testable.
 */
export function createDesktopController({
  settingsStore,
  platformServices,
  notificationCoordinator,
  getLifecycle = () => null,
  applyCodexHome = async () => {},
  validateCodexHome,
  sendDashboardCommand = () => false,
  onLanguageChanged = () => {},
  onAppearanceChanged = () => null,
  openDashboardInBrowserAction = async () => {
    throw controllerError("desktop_dashboard_browser_unavailable");
  },
  showDiagnosticsAction = async () => {
    throw controllerError("desktop_diagnostics_unavailable");
  },
  revealLocalDataAction = async () => {
    throw controllerError("desktop_local_data_unavailable");
  },
  setRecurringTimer = setTimeout,
  clearRecurringTimer = clearTimeout,
} = {}) {
  const store = assertPort(settingsStore, [
    "getSettings",
    "setLanguage",
    "setAppearance",
    "setRefreshInterval",
    "setStartAtLogin",
    "setNotificationPreferences",
    "setSidebarCollapsed",
    "setCodexHome",
    "useDefaultCodexHome",
  ], "settingsStore");
  const platform = assertPort(platformServices, [
    "loginItemStatus",
    "setStartAtLogin",
    "notificationStatus",
    "chooseCodexHome",
    "openSystemSettings",
    "openExternal",
    "about",
  ], "platformServices");
  const coordinator = notificationCoordinator === undefined
    ? createUnavailableNotificationCoordinator()
    : assertPort(notificationCoordinator, ["initialize", "status", "setPreferences"], "notificationCoordinator");
  if (typeof getLifecycle !== "function") throw new TypeError("getLifecycle is required");
  if (typeof applyCodexHome !== "function") throw new TypeError("applyCodexHome is required");
  if (typeof validateCodexHome !== "function") {
    throw new TypeError("validateCodexHome is required");
  }
  if (typeof sendDashboardCommand !== "function") {
    throw new TypeError("sendDashboardCommand is required");
  }
  if (typeof onLanguageChanged !== "function") {
    throw new TypeError("onLanguageChanged is required");
  }
  if (typeof onAppearanceChanged !== "function") {
    throw new TypeError("onAppearanceChanged is required");
  }
  for (const [name, value] of Object.entries({
    openDashboardInBrowserAction,
    showDiagnosticsAction,
    revealLocalDataAction,
  })) {
    if (typeof value !== "function") throw new TypeError(`${name} is required`);
  }
  if (typeof setRecurringTimer !== "function" || typeof clearRecurringTimer !== "function") {
    throw new TypeError("timer functions are required");
  }

  let initialized = false;
  let disposed = false;
  let refreshTimer = null;
  let refreshInFlight = false;
  let refreshLeaseWatchdogTimer = null;
  let refreshLeaseCounter = 0;
  let activeRefreshLease = null;
  let operation = Promise.resolve();
  let activeCodexHome = null;
  let codexHomeRecovery = null;
  let notificationCoordinatorInitialized = false;
  let notificationSafetyFailure = false;

  function enqueue(run) {
    const previous = operation;
    const current = previous.catch(() => {}).then(run);
    operation = current.catch(() => {});
    return current;
  }

  function emitDashboardCommand(command) {
    try {
      return sendDashboardCommand(command) === true;
    } catch {
      return false;
    }
  }

  function notifyLanguageChanged(value) {
    try {
      return onLanguageChanged(value) === true;
    } catch {
      // Native presentation copy must never make a persisted language change
      // fail. The next Settings snapshot remains bounded and recoverable.
      return false;
    }
  }

  function notifyAppearanceChanged(value) {
    try {
      const resolved = onAppearanceChanged(value);
      return resolved === "light" || resolved === "dark" ? resolved : null;
    } catch {
      // Appearance is presentation-only. A host without nativeTheme (for
      // example a plain-Node composition test) must not reject persistence.
      return null;
    }
  }

  function stopRefreshTimer() {
    if (refreshTimer === null) return;
    clearRecurringTimer(refreshTimer);
    refreshTimer = null;
  }

  function stopRefreshLeaseWatchdog() {
    if (refreshLeaseWatchdogTimer === null) return;
    clearRecurringTimer(refreshLeaseWatchdogTimer);
    refreshLeaseWatchdogTimer = null;
  }

  function rearmRefreshTimerFromSettings() {
    return enqueue(async () => {
      if (disposed || refreshInFlight) return false;
      const settings = await store.getSettings();
      startRefreshTimer(settings.refreshIntervalSeconds);
      return true;
    });
  }

  function startRefreshLeaseWatchdog(lease) {
    stopRefreshLeaseWatchdog();
    refreshLeaseWatchdogTimer = setRecurringTimer(() => {
      refreshLeaseWatchdogTimer = null;
      if (activeRefreshLease !== lease) return;
      activeRefreshLease = null;
      refreshInFlight = false;
      void rearmRefreshTimerFromSettings().catch(() => {});
    }, DESKTOP_REFRESH_LEASE_WATCHDOG_MS);
    refreshLeaseWatchdogTimer?.unref?.();
  }

  function startRefreshTimer(seconds) {
    stopRefreshTimer();
    if (disposed || refreshInFlight) return;
    refreshTimer = setRecurringTimer(() => {
      // The desktop cadence is deliberately one-shot. The renderer reports a
      // terminal requestRefresh finally before another timer is armed, so a
      // long accounting pass cannot be started again merely because the app
      // has been open longer than the configured interval.
      refreshTimer = null;
      const delivered = emitDashboardCommand(DASHBOARD_COMMANDS.refresh);
      if (!delivered) {
        // A hidden/restarting dashboard may ignore this tick. Keep a bounded
        // retry armed rather than losing the cadence or spinning commands.
        startRefreshTimer(seconds);
        return;
      }
      // The renderer calls refreshStarted after its POST is accepted. If the
      // command was delivered to a busy renderer and no POST is accepted,
      // this one-shot fallback retries at the normal cadence. An accepted
      // refreshStarted clears it, so long accounting never overlaps itself.
      refreshTimer = setRecurringTimer(() => {
        refreshTimer = null;
        if (!refreshInFlight) startRefreshTimer(seconds);
      }, seconds * 1_000);
    }, seconds * 1_000);
    refreshTimer?.unref?.();
  }

  function readNotificationCoordinatorStatus() {
    try {
      return safeNotificationStatus(coordinator.status());
    } catch {
      return safeNotificationStatus(UNAVAILABLE_NOTIFICATION_STATUS);
    }
  }

  function notificationSnapshot(settings) {
    const coordinatorStatus = notificationSafetyFailure
      ? safeNotificationStatus({
        ...UNAVAILABLE_NOTIFICATION_STATUS,
        lastOutcome: "state_unavailable",
        lastReason: "state_unavailable",
      })
      : readNotificationCoordinatorStatus();
    const permissionStatus = (() => {
      try {
        return platform.notificationStatus();
      } catch {
        return { permission: "unavailable" };
      }
    })();
    const canSet = notificationCapability(coordinatorStatus);
    const permission = typeof permissionStatus?.permission === "string"
      ? permissionStatus.permission
      : "unavailable";
    return Object.freeze({
      enabled: canSet && coordinatorStatus.enabled,
      threshold: canSet ? coordinatorStatus.threshold : "off",
      canSet,
      state: coordinatorStatus.state,
      delivery: coordinatorStatus.delivery,
      lastOutcome: coordinatorStatus.lastOutcome,
      lastReason: coordinatorStatus.lastReason,
      lastDelivery: coordinatorStatus.lastDelivery,
      permission,
      detail: desktopText(
        notificationDetailKey(coordinatorStatus),
        {},
        { locale: settings.language },
      ),
    });
  }

  async function initializeNotificationCoordinator(preferences) {
    if (notificationCoordinatorInitialized) return;
    try {
      await coordinator.initialize();
      // Ordinary settings are authoritative for the UI preference. Applying
      // them after loading the separate policy record starts a fresh policy
      // epoch when the two records disagree; it never resurrects baselines.
      await coordinator.setPreferences(fixedNotificationPreferences(preferences));
    } catch {
      // Notification readiness is a capability, not a startup dependency.
      // The status projection remains closed and the dashboard can still run.
    }
    notificationCoordinatorInitialized = true;
  }

  async function snapshot() {
    const settings = await store.getSettings();
    const login = platform.loginItemStatus();
    const codexHome = activeCodexHome ?? cloneHome(settings.codexHome);
    // The canonical Codex path is a main-process-only value.  The renderer
    // only needs this closed semantic state to render truthful localized copy;
    // returning a path (even a basename) would unnecessarily disclose local
    // filesystem information across the sandbox/IPC boundary.
    const codexFolder = {
      kind: codexHome.mode,
    };
    if (codexHomeRecovery !== null) {
      codexFolder.recovery = codexHomeRecovery;
    }
    return Object.freeze({
      settings: Object.freeze({
        language: settings.language,
        appearance: settings.appearance,
        codexFolder: Object.freeze(codexFolder),
        refreshIntervalSeconds: settings.refreshIntervalSeconds,
        startAtLogin: login,
        sidebarCollapsed: settings.sidebarCollapsed,
        notifications: notificationSnapshot(settings),
      }),
      about: platform.about(),
    });
  }

  async function initialize() {
    if (disposed) throw controllerError("desktop_controller_disposed");
    if (initialized) return snapshot();
    return enqueue(async () => {
      if (initialized) return snapshot();
      const settings = await store.getSettings();
      notifyLanguageChanged(settings.language);
      notifyAppearanceChanged(settings.appearance);
      await initializeNotificationCoordinator(settings.notifications);
      let initialHome = cloneHome(settings.codexHome);
      if (initialHome.mode === "custom") {
        try {
          const validatedPath = await validateCodexHome(initialHome.path);
          if (typeof validatedPath !== "string" || validatedPath.length === 0) {
            throw new TypeError("validated Codex home is invalid");
          }
          initialHome = cloneHome({ mode: "custom", path: validatedPath });
        } catch {
          // A persisted path is data, not an authorization to read arbitrary
          // files. Fall back to the default before the first child launch and
          // make the recoverable state explicit to the settings surface.
          initialHome = Object.freeze({ mode: "default", path: null });
          codexHomeRecovery = Object.freeze({
            status: "fallback",
            reason: "saved_folder_unavailable",
            detail: "The saved Codex folder was unavailable. The default folder is active; choose a folder again in Settings.",
          });
          try {
            await store.useDefaultCodexHome();
          } catch {
            // The active runtime state remains the safe default even when the
            // preference backend cannot be repaired. The recovery marker keeps
            // this divergence visible and gives the user a path to retry.
          }
        }
      }
      activeCodexHome = initialHome;
      await applyCodexHome(initialHome, null);
      startRefreshTimer(settings.refreshIntervalSeconds);
      initialized = true;
      return snapshot();
    });
  }

  function lifecycle() {
    const selected = getLifecycle();
    if (selected === null || typeof selected !== "object") {
      throw controllerError("desktop_lifecycle_unavailable");
    }
    return selected;
  }

  async function updateCodexHome(next) {
    return enqueue(async () => {
      const previousSettings = await store.getSettings();
      const previous = activeCodexHome === null
        ? cloneHome(previousSettings.codexHome)
        : cloneHome(activeCodexHome);
      const selected = cloneHome(next);
      try {
        await applyCodexHome(selected, previous);
        await store.setCodexHome(selected);
        activeCodexHome = selected;
        codexHomeRecovery = null;
      } catch (error) {
        try {
          await applyCodexHome(previous, selected);
        } catch {
          // The platform reconfiguration port owns its own process rollback.
          // This best-effort call prevents persistence from claiming a failed
          // selection without exposing either path through an error.
        }
        void error;
        throw controllerError("desktop_codex_home_change_failed");
      }
      return snapshot();
    });
  }

  async function toggleSidebar() {
    return enqueue(async () => {
      const settings = await store.getSettings();
      const collapsed = !settings.sidebarCollapsed;
      await store.setSidebarCollapsed(collapsed);
      emitDashboardCommand(createDesktopCommand("sidebar", collapsed));
      return snapshot();
    });
  }

  const handlers = Object.freeze({
    async getSettings() {
      return snapshot();
    },
    async openSettings() {
      lifecycle().showSettingsWindow?.("general");
      return snapshot();
    },
    async chooseCodexHome() {
      const selected = await platform.chooseCodexHome();
      if (selected === null) return snapshot();
      return updateCodexHome({ mode: "custom", path: selected });
    },
    async useDefaultCodexHome() {
      return updateCodexHome({ mode: "default", path: null });
    },
    async setLanguage({ value }) {
      return enqueue(async () => {
        await store.setLanguage(value);
        notifyLanguageChanged(value);
        emitDashboardCommand(Object.freeze({ command: "language", value }));
        return snapshot();
      });
    },
    async setAppearance({ value }) {
      if (!DESKTOP_APPEARANCES.includes(value)) {
        throw controllerError("desktop_appearance_invalid");
      }
      return enqueue(async () => {
        await store.setAppearance(value);
        const resolvedTheme = notifyAppearanceChanged(value);
        if (resolvedTheme !== null) {
          emitDashboardCommand(Object.freeze({
            command: "appearance",
            preference: value,
            resolvedTheme,
          }));
        }
        return snapshot();
      });
    },
    async setRefreshInterval({ seconds }) {
      return enqueue(async () => {
        await store.setRefreshInterval(seconds);
        // Do not replace an active lease with a timer. The terminal settle or
        // watchdog recovery will reread this persisted interval exactly once.
        if (!refreshInFlight) startRefreshTimer(seconds);
        return snapshot();
      });
    },
    async setStartAtLogin({ enabled }) {
      return enqueue(async () => {
        const previousSettings = await store.getSettings();
        const result = platform.setStartAtLogin(enabled);
        const accepted = loginItemChangeAccepted(result, enabled);
        if (!accepted) throw controllerError("desktop_start_at_login_unconfirmed");
        try {
          await store.setStartAtLogin(enabled);
        } catch {
          let rollback;
          try {
            rollback = platform.setStartAtLogin(previousSettings.startAtLogin);
          } catch {
            rollback = null;
          }
          if (!loginItemChangeAccepted(rollback, previousSettings.startAtLogin)) {
            throw controllerError("desktop_start_at_login_rollback_failed");
          }
          throw controllerError("desktop_start_at_login_persistence_failed");
        }
        return snapshot();
      });
    },
    async setNotificationPreferences({ enabled, threshold }) {
      return enqueue(async () => {
        const nextPreferences = fixedNotificationPreferences({ enabled, threshold });
        const previousSettings = await store.getSettings();
        const previousPreferences = fixedNotificationPreferences(previousSettings.notifications);
        const before = readNotificationCoordinatorStatus();
        if (!notificationCapability(before)) {
          throw controllerError("desktop_notifications_unavailable");
        }

        let result;
        try {
          result = await coordinator.setPreferences(nextPreferences);
        } catch {
          throw controllerError("desktop_notifications_unavailable");
        }
        const after = readNotificationCoordinatorStatus();
        const resultStatus = safeNotificationStatus(result?.status ?? after);
        const accepted = notificationCapability(resultStatus)
          && resultStatus.enabled === nextPreferences.enabled
          && resultStatus.threshold === nextPreferences.threshold;
        if (!accepted) throw controllerError("desktop_notifications_unavailable");

        try {
          await store.setNotificationPreferences(nextPreferences);
        } catch {
          let rollback;
          try {
            rollback = await coordinator.setPreferences(previousPreferences);
          } catch {
            rollback = null;
          }
          const rollbackStatus = safeNotificationStatus(
            rollback?.status ?? readNotificationCoordinatorStatus(),
          );
          const rollbackAccepted = notificationCapability(rollbackStatus)
            && rollbackStatus.enabled === previousPreferences.enabled
            && rollbackStatus.threshold === previousPreferences.threshold;
          if (!rollbackAccepted) {
            // Once the two persistence records cannot be proven coherent, a
            // later snapshot must not claim that alerts are enabled even if
            // the coordinator still holds the attempted preferences.
            notificationSafetyFailure = true;
            throw controllerError("desktop_notifications_rollback_failed");
          }
          throw controllerError("desktop_notifications_persistence_failed");
        }
        return snapshot();
      });
    },
    async openSystemSettings({ target }) {
      await platform.openSystemSettings(target);
    },
    async openExternal({ target }) {
      await platform.openExternal(target);
    },
    async openHostedSignIn({ authorizeUrl }) {
      if (typeof platform.openHostedSignIn !== "function") {
        throw controllerError("desktop_hosted_signin_unavailable");
      }
      await platform.openHostedSignIn(authorizeUrl);
      return true;
    },
    async checkForUpdates() {
      return snapshot();
    },
    async revealLatestDownload(_args, context = {}) {
      const selected = lifecycle();
      let authorized = false;
      try {
        authorized = typeof selected.isAuthorizedDesktopDownloadContext === "function"
          && selected.isAuthorizedDesktopDownloadContext(
            context.sender,
            context.senderFrame,
          ) === true;
      } catch {
        authorized = false;
      }
      if (!authorized || typeof selected.revealLatestDownload !== "function") {
        throw controllerError("desktop_download_unavailable");
      }
      return selected.revealLatestDownload();
    },
    async openDashboardInBrowser() {
      return openDashboardInBrowserAction();
    },
    async showDiagnostics() {
      return showDiagnosticsAction();
    },
    async revealLocalData() {
      return revealLocalDataAction();
    },
    async refreshStarted() {
      if (disposed) return false;
      if (refreshLeaseCounter >= Number.MAX_SAFE_INTEGER) {
        throw controllerError("desktop_refresh_lease_exhausted");
      }
      refreshLeaseCounter += 1;
      const lease = refreshLeaseCounter;
      activeRefreshLease = lease;
      refreshInFlight = true;
      stopRefreshTimer();
      startRefreshLeaseWatchdog(lease);
      return lease;
    },
    async refreshSettled({ lease } = {}) {
      if (disposed) return false;
      if (!Number.isSafeInteger(lease)
          || lease <= 0
          || activeRefreshLease !== lease) {
        return false;
      }
      activeRefreshLease = null;
      refreshInFlight = false;
      stopRefreshLeaseWatchdog();
      return enqueue(async () => {
        const settings = await store.getSettings();
        startRefreshTimer(settings.refreshIntervalSeconds);
        return true;
      });
    },
  });

  const handlerKeys = Object.keys(handlers);
  if (handlerKeys.length !== DESKTOP_ACTIONS.length
      || !DESKTOP_ACTIONS.every((action) => handlerKeys.includes(action))) {
    throw new TypeError("desktop controller handlers do not match the contract");
  }

  return Object.freeze({
    initialize,
    snapshot,
    handlers,
    showSettings(section = "general") {
      return lifecycle().showSettingsWindow?.(section) ?? false;
    },
    refreshUsage() {
      return emitDashboardCommand(DASHBOARD_COMMANDS.refresh);
    },
    toggleSidebar,
    reconcileDashboardSession() {
      if (disposed) return false;
      if (activeRefreshLease !== null) {
        activeRefreshLease = null;
        refreshInFlight = false;
        stopRefreshLeaseWatchdog();
      }
      void rearmRefreshTimerFromSettings().catch(() => {});
      return true;
    },
    async dispose() {
      disposed = true;
      stopRefreshTimer();
      stopRefreshLeaseWatchdog();
      await operation.catch(() => {});
    },
  });
}

export { DASHBOARD_COMMANDS as DESKTOP_DASHBOARD_COMMANDS };
