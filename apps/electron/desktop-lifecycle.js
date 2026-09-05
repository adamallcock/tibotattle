import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

import {
  createLoopbackNavigationPolicy,
  installLoopbackNavigationPolicy,
  isAllowedCompanionURL,
  isExactLoopbackOrigin,
} from "./loopback-policy.js";
import { shellError } from "./errors.js";
import { DESKTOP_COMMAND_CHANNEL, validateDesktopCommand } from "./desktop-command.js";
import {
  createDesktopActionInterface,
  installDesktopApplicationMenu,
} from "./desktop-menu.js";
import { createDesktopTrayTemplate } from "./desktop-tray.js";
import {
  createDesktopTrayPopover,
  createDesktopTrayPopoverModel,
  TRAY_POPOVER_PRELOAD_FILE,
} from "./desktop-tray-popover.js";
import {
  createRecoveryWindow,
  RECOVERY_STATUSES,
} from "./recovery-window.js";
import {
  installDesktopOwnedDownloadHandler,
} from "./desktop-owned-downloads.js";
import { createDesktopStatusMonitor } from "./desktop-status-monitor.js";
import {
  createDesktopTrayStatusReducer,
  DESKTOP_TRAY_INITIAL_STATUS,
} from "./desktop-tray-status.js";
import {
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  validateDesktopShellStatus,
} from "../../src/desktop-shell-status.js";

const DEFAULT_WINDOW_OPTIONS = Object.freeze({
  width: 1_180,
  height: 820,
  minWidth: 720,
  minHeight: 520,
});

const DEFAULT_SETTINGS_WINDOW_OPTIONS = Object.freeze({
  width: 760,
  height: 760,
  minWidth: 620,
  minHeight: 520,
});

const SETTINGS_SECTIONS = Object.freeze([
  "general",
  "notifications",
  "about",
]);

function assertFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} is required`);
}

/**
 * Coordinates Electron's app/window/tray lifecycle while keeping the child
 * process and renderer security policy dependency-injected for plain Node
 * tests. Closing a window hides it; only an explicit quit tears down the
 * companion.
 */
export function createDesktopLifecycle({
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  supervisor,
  preloadPath,
  icon,
  windowOptions = {},
  createNavigationPolicy = createLoopbackNavigationPolicy,
  installNavigationPolicy = installLoopbackNavigationPolicy,
  appName = "TiboTattle",
  platform = process.platform,
  desktopLocale = "system",
  desktopSystemLocales,
  desktopActions = {},
  settingsWindowOptions = {},
  recoveryWindowOptions = {},
  recoveryPreloadPath,
  trayPopoverWindowOptions = {},
  ownedDownloadsRegistry = null,
  singleInstanceLockAcquired = false,
  onDashboardReady,
  onDashboardInvalidated,
  onDesktopStatus,
  desktopStatusMonitorOptions = {},
  openDashboardExternal,
} = {}) {
  if (!app || typeof app.on !== "function") throw new TypeError("app is required");
  assertFunction(BrowserWindow, "BrowserWindow");
  assertFunction(supervisor?.start, "supervisor.start");
  assertFunction(supervisor?.stop, "supervisor.stop");
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    throw new TypeError("preloadPath is required");
  }
  if (typeof createNavigationPolicy !== "function"
      || typeof installNavigationPolicy !== "function") {
    throw new TypeError("navigation policy factories are required");
  }
  if (ownedDownloadsRegistry !== null) {
    for (const method of ["prepareDownload", "completeDownload", "failDownload", "revealLatest"]) {
      if (typeof ownedDownloadsRegistry[method] !== "function") {
        throw new TypeError(`ownedDownloadsRegistry.${method} is required`);
      }
    }
    if (typeof ownedDownloadsRegistry.clear !== "function") {
      throw new TypeError("ownedDownloadsRegistry.clear is required");
    }
  }
  if (onDesktopStatus !== undefined && typeof onDesktopStatus !== "function") {
    throw new TypeError("onDesktopStatus must be a function");
  }
  if (onDashboardInvalidated !== undefined
      && typeof onDashboardInvalidated !== "function") {
    throw new TypeError("onDashboardInvalidated must be a function");
  }
  if (openDashboardExternal !== undefined
      && typeof openDashboardExternal !== "function") {
    throw new TypeError("openDashboardExternal must be a function");
  }
  if (desktopStatusMonitorOptions === null
      || typeof desktopStatusMonitorOptions !== "object"
      || Array.isArray(desktopStatusMonitorOptions)
      || Object.hasOwn(desktopStatusMonitorOptions, "onStatus")) {
    throw new TypeError("desktop status monitor options are invalid");
  }

  let started = false;
  let quitting = false;
  let primaryInstance = false;
  let window = null;
  let settingsWindow = null;
  let recovery = null;
  let tray = null;
  let trayPopover = null;
  let applicationMenu = null;
  let desktopActionInterface = null;
  let activeDesktopLocale = desktopLocale;
  let dashboardReady = false;
  let ready = null;
  let policyInstallation = null;
  let downloadHandlerInstallation = null;
  let settingsPolicyInstallation = null;
  let windowListenerCleanup = null;
  let windowReadyListenerCleanup = null;
  let settingsWindowListenerCleanup = null;
  let settingsWindowReadyListenerCleanup = null;
  let dashboardLoadState = null;
  let settingsLoadState = null;
  let recoveryWindowListenerCleanup = null;
  let destroyingSettingsWindow = false;
  let destroyingRecoveryWindow = false;
  let settingsLoadedURL = null;
  let shutdownPromise = null;
  let retryPromise = null;
  let automaticRetryPromise = null;
  let automaticRetryUsed = false;
  let startupInProgress = false;
  let startupUnexpectedExit = false;
  let startupFailureStatus = null;
  let startupAttemptPromise = null;
  let lifecycleActive = false;
  let recoveryStatus = null;
  let lifecycleEpoch = 0;
  let lifecycleOperation = Promise.resolve();
  let desktopStatusMonitorRunning = false;
  let desktopStatusMonitorOrigin = null;
  const desktopTrayStatusReducer = createDesktopTrayStatusReducer();
  let desktopTrayStatus = DESKTOP_TRAY_INITIAL_STATUS;
  const listeners = [];

  const unavailableDesktopStatus = Object.freeze({
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state: "unavailable",
    allowance: null,
    notificationEvidence: null,
  });

  function notifyDesktopStatus(status) {
    if (typeof onDesktopStatus !== "function") return;
    try {
      onDesktopStatus(status);
    } catch {
      // The observer is an internal convenience seam for notification/UI
      // coordination. Its failure must never interrupt the shell lifecycle.
    }
  }

  function sameAllowance(left, right) {
    if (left === right) return true;
    if (left === null || right === null) return false;
    return left.source === right.source
      && left.window === right.window
      && left.remainingPercent === right.remainingPercent;
  }

  function sameTrayStatus(left, right) {
    return left.status === right.status
      && sameAllowance(left.allowance, right.allowance)
      && left.notificationEvidence?.continuityKey === right.notificationEvidence?.continuityKey
      && left.notificationEvidence?.observedAt === right.notificationEvidence?.observedAt;
  }

  function dispatchDesktopTrayEvent(event) {
    let next;
    try {
      next = desktopTrayStatusReducer.dispatch(event);
    } catch {
      // A malformed status must fail closed without surfacing any source
      // payload or taking down the main process.
      return false;
    }
    const changed = !sameTrayStatus(desktopTrayStatus, next);
    desktopTrayStatus = next;
    if (changed) refreshDesktopSurfaces();
    return changed;
  }

  function handleDesktopStatus(status) {
    let validated;
    try {
      validated = validateDesktopShellStatus(status);
      const event = validated.state === "fresh"
        ? {
          type: "fresh",
          allowance: validated.allowance,
          notificationEvidence: validated.notificationEvidence,
        }
        : { type: validated.state };
      dispatchDesktopTrayEvent(event);
    } catch {
      validated = unavailableDesktopStatus;
      dispatchDesktopTrayEvent({ type: "unavailable" });
    }
    notifyDesktopStatus(validated);
  }

  function stopDesktopStatusMonitor({ notify = true } = {}) {
    const wasRunning = desktopStatusMonitorRunning || desktopStatusMonitorOrigin !== null;
    try {
      desktopStatusMonitor?.stop?.();
    } catch {
      // Monitor cleanup is best-effort during recovery and shutdown.
    }
    desktopStatusMonitorRunning = false;
    desktopStatusMonitorOrigin = null;
    if (notify && wasRunning) handleDesktopStatus(unavailableDesktopStatus);
  }

  function startDesktopStatusMonitor(origin) {
    if (desktopStatusMonitorRunning && desktopStatusMonitorOrigin === origin) return;
    stopDesktopStatusMonitor({ notify: false });
    // Mark ownership before start(): the monitor emits its fixed `starting`
    // status synchronously, and an internal observer is allowed to request
    // quit/recovery from that callback.
    desktopStatusMonitorRunning = true;
    desktopStatusMonitorOrigin = origin;
    try {
      desktopStatusMonitor.start(origin);
      if (quitting) stopDesktopStatusMonitor();
    } catch {
      desktopStatusMonitorRunning = false;
      desktopStatusMonitorOrigin = null;
      handleDesktopStatus(unavailableDesktopStatus);
    }
  }

  const desktopStatusMonitor = createDesktopStatusMonitor({
    ...desktopStatusMonitorOptions,
    onStatus: handleDesktopStatus,
  });

  function listen(target, event, handler) {
    target.on(event, handler);
    listeners.push(() => target.off?.(event, handler));
  }

  function showApplicationWindow(target) {
    if (!target || target.isDestroyed?.()) return false;
    // macOS can hide the application as a whole when its last window is
    // closed or when the status item is used.  BrowserWindow.show() alone
    // does not undo that application-level hidden state; app.show() is the
    // supported counterpart.  app.focus({ steal: true }) is needed as well:
    // app.show() makes the layer visible but does not make the status-item
    // application frontmost.  Both calls are restricted to macOS; optional
    // invocation keeps dependency-injected and older runtimes fail-safe.
    if (platform === "darwin") app.show?.();
    target.show?.();
    if (platform === "darwin") app.focus?.({ steal: true });
    target.focus?.();
    return true;
  }

  function showWindow() {
    if (window && !window.isDestroyed?.()) {
      return showApplicationWindow(window);
    }
    if (!recovery?.window || recovery.window.isDestroyed?.()) return false;
    if (platform === "darwin") {
      app.show?.();
      app.focus?.({ steal: true });
    }
    recovery.show?.();
    return true;
  }

  function hideWindow() {
    if (window && !window.isDestroyed?.()) {
      window.hide?.();
      return true;
    }
    return recovery?.hide?.() === true;
  }

  function toggleWindow() {
    const target = window && !window.isDestroyed?.() ? window : recovery?.window;
    if (!target || target.isDestroyed?.()) return false;
    if (target.isVisible?.()) return hideWindow();
    return showWindow();
  }

  function sendDashboardCommand(value) {
    let command;
    try {
      command = validateDesktopCommand(value);
    } catch {
      return false;
    }
    let delivered = false;
    if (isLiveBrowserWindow(window) && typeof window.webContents?.send === "function") {
      window.webContents.send(DESKTOP_COMMAND_CHANNEL, command);
      delivered = true;
    }
    // Refresh belongs only to the dashboard. Language is shared presentation
    // state, so an already-open trusted Settings renderer receives that same
    // validated command and no broader broadcast surface.
    if ((command.command === "language" || command.command === "appearance")
        && isLiveBrowserWindow(settingsWindow)
        && typeof settingsWindow.webContents?.send === "function") {
      settingsWindow.webContents.send(DESKTOP_COMMAND_CHANNEL, command);
      delivered = true;
    }
    return delivered;
  }

  // Keep native dashboard navigation bounded to the two evidence-rich views
  // that are useful from a menu-bar shell. The renderer owns the page state
  // and existing projections; the main process only requests a fixed hash
  // after bringing the dashboard window to the front.
  function navigateDashboardSection(section) {
    if (section !== "weekly" && section !== "timeline" && section !== "accounting") return false;
    if (!showWindow()) return false;
    return sendDashboardCommand({ command: "dashboardSection", section });
  }

  function isLiveBrowserWindow(candidate) {
    return candidate !== null && candidate !== undefined
      && candidate.isDestroyed?.() !== true;
  }

  function isAuthorizedDesktopSender(sender) {
    return (isLiveBrowserWindow(window) && sender === window.webContents)
      || (isLiveBrowserWindow(settingsWindow) && sender === settingsWindow.webContents);
  }

  function isAuthorizedDashboardSender(sender) {
    return isLiveBrowserWindow(window) && sender === window.webContents;
  }

  function isAuthorizedDashboardFrame(frame, event = undefined) {
    if (!frame || typeof frame !== "object") return false;
    const sender = event?.sender;
    if (!isAuthorizedDashboardSender(sender)) return false;
    if (!isLiveBrowserWindow(window)) return false;
    // Electron's mainFrame identity is the authoritative top-frame check. The
    // additional shape checks make the predicate fail closed in tests and in
    // any future Electron object that does not expose the usual frame fields.
    if (window.webContents?.mainFrame !== frame) return false;
    if (Object.hasOwn(frame, "isMainFrame") && frame.isMainFrame !== true) return false;
    if (Object.hasOwn(frame, "parent") && frame.parent !== null) return false;
    return true;
  }

  function isAuthorizedCodexThreadNavigation(frame, event = undefined) {
    if (!dashboardReady
        || !started
        || !isAuthorizedDashboardFrame(frame, event)
        || !isExactLoopbackOrigin(ready?.origin)) {
      return false;
    }
    // The preload's trusted click is only a first-stage gesture gate. Recheck
    // the live dashboard URL here so a stale renderer that navigated elsewhere
    // cannot use the narrow action after its frame identity remains allocated.
    const getURL = window?.webContents?.getURL;
    if (typeof getURL !== "function") return false;
    try {
      const currentURL = getURL.call(window.webContents);
      if (!isAllowedCompanionURL(currentURL, ready.origin)) return false;
      const parsed = new URL(currentURL);
      // The handoff is dashboard-only.  Keep section hashes usable, but do
      // not authorize a same-origin Settings, asset, or query-bearing page.
      return parsed.pathname === "/" && parsed.search === "";
    } catch {
      return false;
    }
  }

  function isAuthorizedSettingsFrame(frame, event = undefined) {
    if (!frame || typeof frame !== "object") return false;
    const sender = event?.sender;
    if (!isLiveBrowserWindow(settingsWindow) || sender !== settingsWindow.webContents) {
      return false;
    }
    if (settingsWindow.webContents?.mainFrame !== frame) return false;
    if (Object.hasOwn(frame, "isMainFrame") && frame.isMainFrame !== true) return false;
    if (Object.hasOwn(frame, "parent") && frame.parent !== null) return false;
    // Navigation policy is the primary URL gate. Recheck the live URL when
    // Electron exposes it so a renderer that navigated away cannot retain
    // access to pathful root settings actions.
    const getURL = settingsWindow.webContents?.getURL;
    if (typeof getURL === "function") {
      let currentURL;
      try {
        currentURL = getURL.call(settingsWindow.webContents);
        const parsed = new URL(currentURL);
        if (!isExactLoopbackOrigin(ready?.origin)
            || parsed.origin !== ready.origin
            || parsed.pathname !== "/electron-settings.html"
            || parsed.search !== ""
            || parsed.username !== ""
            || parsed.password !== "") {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  function isAuthorizedDesktopFrame(frame, event = undefined) {
    if (isAuthorizedDashboardFrame(frame, event)) return true;
    return isAuthorizedSettingsFrame(frame, event);
  }

  function isAuthorizedDesktopDownloadContext(sender, frame) {
    if (!isLiveBrowserWindow(window)
        || sender !== window.webContents
        || !isAuthorizedDesktopFrame(frame, { sender })) {
      return false;
    }
    const currentOrigin = ready?.origin;
    if (typeof currentOrigin !== "string") return false;
    const getURL = sender.getURL;
    if (typeof getURL !== "function") return true;
    let currentURL;
    try {
      currentURL = getURL.call(sender);
      return typeof currentURL === "string"
        && new URL(currentURL).origin === currentOrigin;
    } catch {
      return false;
    }
  }

  async function openDashboardInBrowser() {
    if (!isExactLoopbackOrigin(ready?.origin)
        || typeof openDashboardExternal !== "function") {
      throw shellError("desktop_dashboard_browser_unavailable");
    }
    const target = `${ready.origin}/`;
    try {
      const opened = await openDashboardExternal(target);
      if (opened === false) throw new Error("dashboard browser open was rejected");
    } catch {
      throw shellError("desktop_dashboard_browser_unavailable");
    }
    return true;
  }

  function assertSettingsSection(section) {
    if (!SETTINGS_SECTIONS.includes(section)) {
      throw new TypeError("settings section is invalid");
    }
    return section;
  }

  function settingsURL(section) {
    assertSettingsSection(section);
    if (!ready?.origin) throw shellError("electron_configuration_invalid");
    const url = new URL("/electron-settings.html", `${ready.origin}/`);
    url.hash = section;
    return url.href;
  }

  function recoveryStatusFor(error, fallback = "companion_spawn_failed") {
    const candidate = typeof error?.code === "string"
      ? error.code.replace(/^electron_shell_/u, "")
      : fallback;
    return RECOVERY_STATUSES.includes(candidate) && candidate !== "starting"
      ? candidate
      : fallback;
  }

  function handleRecoveryAction(action) {
    if (action === "retry") {
      void retry().catch(() => {});
      return;
    }
    if (action === "settings") {
      // The normal HTML Settings surface has no safe origin until the
      // companion is ready. Runtime composition supplies a main-process-only
      // recovery settings action (folder repair); the lifecycle never grants
      // this data-URL renderer the normal desktop bridge.
      try {
        const recoverySettings = desktopActions !== null
          && typeof desktopActions === "object"
          && !Array.isArray(desktopActions)
          ? desktopActions.recoverySettings
          : null;
        const result = typeof recoverySettings === "function"
          ? recoverySettings()
          : undefined;
        result?.catch?.(() => {});
      } catch {
        // Recovery remains usable through Retry and Quit if the bounded native
        // settings action itself is unavailable.
      }
      return;
    }
    if (action === "diagnostics") {
      try {
        const diagnostics = desktopActions !== null
          && typeof desktopActions === "object"
          && !Array.isArray(desktopActions)
          ? desktopActions.diagnostics
          : null;
        const result = typeof diagnostics === "function" ? diagnostics() : undefined;
        result?.catch?.(() => {});
      } catch {
        // Retry and Quit remain available if the native diagnostics dialog is
        // unavailable during an early startup failure.
      }
      return;
    }
    if (action === "quit") void requestQuit().catch(() => {});
  }

  function destroyRecoveryWindow() {
    recoveryWindowListenerCleanup?.();
    recoveryWindowListenerCleanup = null;
    const candidate = recovery;
    recovery = null;
    recoveryStatus = null;
    if (!candidate) return;
    destroyingRecoveryWindow = true;
    try {
      candidate.destroy?.();
    } finally {
      destroyingRecoveryWindow = false;
    }
  }

  function showRecoveryWindow(status = "starting") {
    if (quitting) return false;
    if (!RECOVERY_STATUSES.includes(status)) status = "companion_spawn_failed";
    if (!recovery || recovery.window?.isDestroyed?.()) {
      const selectedPreloadPath = recoveryPreloadPath
        ?? resolve(dirname(preloadPath), "recovery-preload.cjs");
      recovery = createRecoveryWindow({
        BrowserWindow,
        preloadPath: selectedPreloadPath,
        status,
        windowOptions: recoveryWindowOptions,
        onAction: handleRecoveryAction,
        locale: activeDesktopLocale,
        systemLocales: desktopSystemLocales,
      });
      const recoveryWindow = recovery.window;
      const onWindowClose = (event) => {
        if (quitting || destroyingRecoveryWindow) return;
        event?.preventDefault?.();
        recovery?.hide?.();
      };
      recoveryWindow.on?.("close", onWindowClose);
      recoveryWindowListenerCleanup = () => {
        recoveryWindow.off?.("close", onWindowClose);
      };
    } else if (recovery.status !== status) {
      recovery.setStatus(status);
    }
    recoveryStatus = status;
    recovery.show?.();
    return true;
  }

  // Keep tray menu actions on the same bounded window operations used by the
  // test-only packaged smoke control. The control never receives this method
  // through the renderer or preload boundary.
  function invokeTrayCommand(command) {
    if (command === "show") return showWindow();
    if (command === "hide") return hideWindow();
    if (command === "toggle") return toggleWindow();
    return false;
  }

  function currentTrayPopoverModel() {
    return createDesktopTrayPopoverModel({
      appName,
      trayStatus: desktopTrayStatus,
      locale: activeDesktopLocale,
      systemLocales: desktopSystemLocales,
    });
  }

  function invokeTrayPopoverAction(action) {
    const actions = getDesktopActionInterface();
    let selected = null;
    if (action === "open") selected = actions.show;
    else if (action === "weekly") selected = actions.weekly;
    else if (action === "timeline") selected = actions.timeline;
    else if (action === "accounting") selected = actions.accounting;
    else if (action === "settings") selected = actions.settings;
    else if (action === "quit") selected = actions.quit;
    else if (action === "refresh") {
      selected = desktopTrayStatus?.status === "unavailable"
        ? actions.retry
        : actions.refresh;
    }
    if (typeof selected !== "function") return false;
    try {
      const result = selected();
      result?.catch?.(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function createTrayPopover() {
    if (trayPopover !== null || typeof BrowserWindow !== "function") return trayPopover;
    const selectedPreloadPath = resolve(dirname(preloadPath), TRAY_POPOVER_PRELOAD_FILE);
    // Keep plain-Node lifecycle compositions and old development staging
    // trees on the existing menu path until the reviewed preload is present.
    if (!existsSync(selectedPreloadPath)
        || !isExactLoopbackOrigin(ready?.origin)) return null;
    const selectedPageURL = new URL(
      "/electron-tray-popup.html",
      `${ready.origin}/`,
    ).href;
    try {
      trayPopover = createDesktopTrayPopover({
        BrowserWindow,
        preloadPath: selectedPreloadPath,
        pageURL: selectedPageURL,
        origin: ready.origin,
        tray,
        screen,
        platform,
        model: currentTrayPopoverModel(),
        onAction: invokeTrayPopoverAction,
        windowOptions: trayPopoverWindowOptions,
      });
    } catch {
      trayPopover = null;
    }
    return trayPopover;
  }

  function destroyTrayPopover() {
    trayPopover?.destroy?.();
    trayPopover = null;
  }

  function showTrayPopover(bounds) {
    const selectedPopover = trayPopover ?? createTrayPopover();
    if (selectedPopover === null) return false;
    return selectedPopover.show(bounds) === true;
  }

  function getDesktopActionInterface() {
    if (desktopActionInterface !== null) return desktopActionInterface;
    const suppliedActions = desktopActions === null
      || typeof desktopActions !== "object"
      || Array.isArray(desktopActions)
      ? {}
      : desktopActions;
    desktopActionInterface = createDesktopActionInterface({
      ...suppliedActions,
      show: suppliedActions.show ?? showWindow,
      focus: suppliedActions.focus ?? showWindow,
      refresh: suppliedActions.refresh ?? (() => sendDashboardCommand({ command: "refresh" })),
      weekly: suppliedActions.weekly ?? (() => navigateDashboardSection("weekly")),
      timeline: suppliedActions.timeline ?? (() => navigateDashboardSection("timeline")),
      accounting: suppliedActions.accounting ?? (() => navigateDashboardSection("accounting")),
      toggleSidebar: suppliedActions.toggleSidebar ?? (() => false),
      retry: suppliedActions.retry ?? (() => retry()),
      settings: suppliedActions.settings ?? (() => showSettingsWindow()),
      about: suppliedActions.about ?? (() => showSettingsWindow("about")),
      quit: suppliedActions.quit ?? (() => { void requestQuit(); }),
    });
    return desktopActionInterface;
  }

  function enqueueExclusive(operation) {
    const previous = lifecycleOperation;
    const current = previous.catch(() => {}).then(operation);
    lifecycleOperation = current.catch(() => {});
    return current;
  }

  function destroyWindow() {
    const hadDashboardWindow = window !== null;
    dashboardReady = false;
    dashboardLoadState = null;
    downloadHandlerInstallation?.remove?.();
    downloadHandlerInstallation = null;
    windowReadyListenerCleanup?.();
    windowReadyListenerCleanup = null;
    windowListenerCleanup?.();
    windowListenerCleanup = null;
    policyInstallation?.remove?.();
    policyInstallation = null;
    if (window && !window.isDestroyed?.()) window.destroy?.();
    window = null;
    if (hadDashboardWindow) {
      try {
        onDashboardInvalidated?.();
      } catch {
        // Session invalidation is a bounded controller recovery hook. Its
        // failure must not interrupt renderer teardown or recovery UI.
      }
    }
  }

  function destroySettingsWindow() {
    settingsLoadState = null;
    settingsWindowReadyListenerCleanup?.();
    settingsWindowReadyListenerCleanup = null;
    settingsWindowListenerCleanup?.();
    settingsWindowListenerCleanup = null;
    settingsPolicyInstallation?.remove?.();
    settingsPolicyInstallation = null;
    const candidate = settingsWindow;
    settingsWindow = null;
    settingsLoadedURL = null;
    if (!candidate || candidate.isDestroyed?.()) return;
    destroyingSettingsWindow = true;
    try {
      candidate.destroy?.();
    } finally {
      destroyingSettingsWindow = false;
    }
  }

  function revealDashboardWhenLoaded(state) {
    if (dashboardLoadState !== state
        || state.failed
        || state.loadSucceeded !== true
        || state.readyToShow !== true
        || window !== state.window
        || !isLiveBrowserWindow(window)
        || dashboardReady) {
      return false;
    }
    dashboardReady = true;
    showApplicationWindow(state.window);
    try {
      onDashboardReady?.();
    } catch {
      // A bounded deep-link wake callback is presentation-only. A callback
      // failure must not tear down the trusted dashboard lifecycle.
    }
    return true;
  }

  function settleDashboardLoadFailure(state, code = "companion_spawn_failed") {
    if (!state) return false;
    state.failed = true;
    if (!state.promiseSettled) {
      state.promiseSettled = true;
      state.reject(shellError(code));
    }
    return true;
  }

  function handleDashboardLoadFailure(state) {
    if (dashboardLoadState !== state || state.failed) return false;
    settleDashboardLoadFailure(state);
    if (state.failureHandled || !started || startupInProgress || quitting) return true;
    state.failureHandled = true;
    dashboardReady = false;
    stopDesktopStatusMonitor();
    ready = null;
    destroyWindow();
    destroySettingsWindow();
    started = false;
    startupFailureStatus = "companion_spawn_failed";
    showRecoveryWindow(startupFailureStatus);
    scheduleAutomaticRetry({ status: startupFailureStatus });
    return true;
  }

  function handleSettingsLoadFailure(candidate) {
    const state = settingsLoadState;
    if (!state || state.candidate !== candidate || state.failed) return false;
    state.failed = true;
    // A failed auxiliary renderer is never left as a hidden or blank zombie.
    // The next explicit Settings action creates a fresh, independently
    // guarded BrowserWindow. No URL or renderer error crosses this boundary.
    destroySettingsWindow();
    return true;
  }

  function startSettingsLoad(candidate, url) {
    const state = settingsLoadState;
    if (!state || state.candidate !== candidate || state.failed) return false;
    settingsLoadedURL = url;
    let loadResult;
    try {
      loadResult = candidate.loadURL?.(url);
    } catch {
      handleSettingsLoadFailure(candidate);
      return false;
    }
    Promise.resolve(loadResult).then(
      () => {
        if (settingsLoadState !== state || state.failed) return;
        state.loadSucceeded = true;
        if (state.readyToShow) showApplicationWindow(candidate);
      },
      () => {
        handleSettingsLoadFailure(candidate);
      },
    );
    return true;
  }

  function createWindow() {
    if (window && !window.isDestroyed?.()) return window;
    if (!ready?.origin) throw shellError("electron_configuration_invalid");
    const selectedOptions = {
      ...DEFAULT_WINDOW_OPTIONS,
      ...windowOptions,
      webPreferences: {
        ...(windowOptions.webPreferences ?? {}),
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
      show: false,
    };
    window = new BrowserWindow(selectedOptions);
    dashboardReady = false;
    const webContents = window.webContents;
    const session = webContents?.session;
    const policy = createNavigationPolicy({ origin: ready.origin });
    policyInstallation = installNavigationPolicy({
      webContents,
      session,
      policy,
      allowBlobDownloads: true,
    });
    if (ownedDownloadsRegistry !== null) {
      downloadHandlerInstallation = installDesktopOwnedDownloadHandler({
        session,
        dashboardWebContents: webContents,
        origin: ready.origin,
        registry: ownedDownloadsRegistry,
        onState: (command) => {
          // The download handler can settle asynchronously, after a retry or
          // shutdown has invalidated this BrowserWindow.  Only the current,
          // already-visible dashboard may receive the fixed semantic state;
          // no stale renderer gets a completion signal.
          if (!dashboardReady
              || window?.webContents !== webContents
              || !isLiveBrowserWindow(window)) {
            return;
          }
          sendDashboardCommand(command);
        },
      });
    }
    let resolveDashboardLoad;
    let rejectDashboardLoad;
    const loadPromise = new Promise((resolve, reject) => {
      resolveDashboardLoad = resolve;
      rejectDashboardLoad = reject;
    });
    // The startup path awaits this promise when it owns the load. The noop
    // rejection handler also keeps an asynchronous post-start renderer crash
    // from becoming an unhandled main-process rejection.
    loadPromise.catch(() => {});
    const loadState = {
      failureHandled: false,
      failed: false,
      loadSucceeded: false,
      promiseSettled: false,
      readyToShow: false,
      reject: rejectDashboardLoad,
      resolve: resolveDashboardLoad,
      promise: loadPromise,
      window,
    };
    dashboardLoadState = loadState;
    const onReadyToShow = () => {
      if (dashboardLoadState !== loadState || loadState.failed) return;
      loadState.readyToShow = true;
      revealDashboardWhenLoaded(loadState);
    };
    const onDidFailLoad = (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      handleDashboardLoadFailure(loadState);
    };
    const onRenderProcessGone = () => {
      handleDashboardLoadFailure(loadState);
    };
    window.once?.("ready-to-show", onReadyToShow);
    webContents?.on?.("did-fail-load", onDidFailLoad);
    webContents?.on?.("render-process-gone", onRenderProcessGone);
    windowReadyListenerCleanup = () => {
      window?.off?.("ready-to-show", onReadyToShow);
      webContents?.off?.("did-fail-load", onDidFailLoad);
      webContents?.off?.("render-process-gone", onRenderProcessGone);
    };
    const onWindowClose = (event) => {
      if (quitting) return;
      event?.preventDefault?.();
      hideWindow();
    };
    window.on("close", onWindowClose);
    windowListenerCleanup = () => {
      window?.off?.("close", onWindowClose);
    };
    let loadResult;
    try {
      loadResult = window.loadURL?.(`${ready.origin}/`);
    } catch {
      handleDashboardLoadFailure(loadState);
      throw shellError("companion_spawn_failed");
    }
    Promise.resolve(loadResult).then(
      () => {
        if (dashboardLoadState !== loadState || loadState.failed) return;
        loadState.loadSucceeded = true;
        loadState.promiseSettled = true;
        loadState.resolve();
        revealDashboardWhenLoaded(loadState);
      },
      () => {
        handleDashboardLoadFailure(loadState);
      },
    );
    return window;
  }

  function createSettingsWindow(section) {
    const url = settingsURL(section);
    if (isLiveBrowserWindow(settingsWindow)) return settingsWindow;
    if (!ready?.origin) throw shellError("electron_configuration_invalid");
    const suppliedSettingsOptions = settingsWindowOptions === null
      || typeof settingsWindowOptions !== "object"
      || Array.isArray(settingsWindowOptions)
      ? {}
      : settingsWindowOptions;
    const selectedOptions = {
      ...DEFAULT_SETTINGS_WINDOW_OPTIONS,
      ...suppliedSettingsOptions,
      webPreferences: {
        ...(suppliedSettingsOptions.webPreferences ?? {}),
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
      show: false,
    };
    settingsWindow = new BrowserWindow(selectedOptions);
    const candidate = settingsWindow;
    const webContents = settingsWindow.webContents;
    const session = webContents?.session;
    const policy = createNavigationPolicy({ origin: ready.origin });
    settingsPolicyInstallation = installNavigationPolicy({
      webContents,
      session,
      policy,
    });
    const settingsState = {
      candidate,
      failed: false,
      loadSucceeded: false,
      readyToShow: false,
    };
    settingsLoadState = settingsState;
    const onReadyToShow = () => {
      if (settingsLoadState !== settingsState || settingsState.failed) return;
      settingsState.readyToShow = true;
      if (isLiveBrowserWindow(settingsWindow)) {
        showApplicationWindow(settingsWindow);
      }
    };
    const onDidFailLoad = (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      handleSettingsLoadFailure(candidate);
    };
    const onRenderProcessGone = () => {
      handleSettingsLoadFailure(candidate);
    };
    settingsWindow.once?.("ready-to-show", onReadyToShow);
    webContents?.on?.("did-fail-load", onDidFailLoad);
    webContents?.on?.("render-process-gone", onRenderProcessGone);
    settingsWindowReadyListenerCleanup = () => {
      candidate?.off?.("ready-to-show", onReadyToShow);
      webContents?.off?.("did-fail-load", onDidFailLoad);
      webContents?.off?.("render-process-gone", onRenderProcessGone);
    };
    const onWindowClose = (event) => {
      if (quitting || destroyingSettingsWindow) return;
      event?.preventDefault?.();
      settingsWindow?.hide?.();
    };
    const onWindowClosed = () => {
      // Electron may destroy the BrowserWindow before it emits `closed`.
      // Reading `settingsWindow.webContents` at that point throws
      // "Object has been destroyed" in the main process, which can make a
      // transient Settings close look like the whole app disappeared. The
      // captured object identity is sufficient to reject stale close events
      // and remains safe after Electron invalidates the object.
      if (settingsWindow !== candidate) return;
      settingsWindowReadyListenerCleanup?.();
      settingsWindowReadyListenerCleanup = null;
      settingsWindowListenerCleanup = null;
      settingsPolicyInstallation?.remove?.();
      settingsPolicyInstallation = null;
      settingsWindow = null;
      settingsLoadedURL = null;
      if (settingsLoadState === settingsState) settingsLoadState = null;
    };
    settingsWindow.on("close", onWindowClose);
    settingsWindow.on("closed", onWindowClosed);
    settingsWindowListenerCleanup = () => {
      candidate?.off?.("close", onWindowClose);
      candidate?.off?.("closed", onWindowClosed);
    };
    if (!startSettingsLoad(candidate, url)) return null;
    return settingsWindow;
  }

  function showSettingsWindow(section = "general") {
    const selectedSection = assertSettingsSection(section);
    if (!started || quitting || !ready?.origin) return false;
    const hadWindow = isLiveBrowserWindow(settingsWindow);
    const target = createSettingsWindow(selectedSection);
    if (!isLiveBrowserWindow(target)) return false;
    const targetURL = settingsURL(selectedSection);
    if (hadWindow && settingsLoadedURL !== targetURL) {
      if (!startSettingsLoad(target, targetURL)) return false;
    }
    // A newly-created window waits for ready-to-show to avoid a blank flash;
    // an existing window is already safe to show and should be focused now.
    if (hadWindow) {
      showApplicationWindow(target);
    }
    return true;
  }

  function createTray() {
    if (tray || typeof Tray !== "function") return tray;
    if (icon === undefined) throw shellError("electron_configuration_invalid");
    tray = new Tray(icon);
    tray.setToolTip?.(appName);
    const template = createDesktopTrayTemplate({
      appName,
      actions: getDesktopActionInterface(),
      trayStatus: desktopTrayStatus,
      locale: activeDesktopLocale,
      systemLocales: desktopSystemLocales,
    });
    const menu = Menu?.buildFromTemplate?.(template);
    tray.setContextMenu?.(menu);
    const projected = desktopTrayStatusReducer.project();
    tray.setTitle?.(platform === "darwin" ? projected.compactTitle : "");
    tray.on?.("click", (_event, bounds) => {
      const selectedPopover = trayPopover ?? createTrayPopover();
      if (selectedPopover?.toggle(bounds) === true) return;
      invokeTrayCommand("toggle");
    });
    // Electron opens the context menu for the native secondary click. Hiding
    // the visual surface first keeps the two tray affordances from stacking.
    tray.on?.("right-click", () => trayPopover?.hide?.());
    return tray;
  }

  function createApplicationMenu() {
    if (applicationMenu !== null) return applicationMenu;
    applicationMenu = installDesktopApplicationMenu({
      Menu,
      appName,
      platform,
      actions: getDesktopActionInterface(),
      locale: activeDesktopLocale,
      systemLocales: desktopSystemLocales,
    });
    return applicationMenu;
  }

  function refreshDesktopSurfaces() {
    if (applicationMenu !== null) {
      applicationMenu = installDesktopApplicationMenu({
        Menu,
        appName,
        platform,
        actions: getDesktopActionInterface(),
        locale: activeDesktopLocale,
        systemLocales: desktopSystemLocales,
      });
    }
    if (tray && typeof Menu?.buildFromTemplate === "function") {
      const template = createDesktopTrayTemplate({
        appName,
        actions: getDesktopActionInterface(),
        trayStatus: desktopTrayStatus,
        locale: activeDesktopLocale,
        systemLocales: desktopSystemLocales,
      });
      tray.setContextMenu?.(Menu.buildFromTemplate(template));
      const projected = desktopTrayStatusReducer.project();
      tray.setTitle?.(platform === "darwin" ? projected.compactTitle : "");
      trayPopover?.setModel(currentTrayPopoverModel());
    }
  }

  function setDesktopLanguage(value) {
    activeDesktopLocale = value;
    if (!started || quitting) return false;
    refreshDesktopSurfaces();
    return true;
  }

  async function attemptStartup() {
    if (startupAttemptPromise !== null) return startupAttemptPromise;
    startupAttemptPromise = (async () => {
      startupInProgress = true;
      startupUnexpectedExit = false;
      startupFailureStatus = null;
      showRecoveryWindow("starting");
      try {
        ready = await supervisor.start();
        if (startupUnexpectedExit) {
          throw shellError("companion_exit_before_ready");
        }
        if (quitting) {
          await supervisor.stop().catch(() => {});
          throw shellError("companion_not_running");
        }
        createWindow();
        const dashboardLoad = dashboardLoadState;
        await dashboardLoad?.promise;
        if (dashboardLoad?.failed) {
          throw shellError("companion_spawn_failed");
        }
        if (startupUnexpectedExit) {
          throw shellError("companion_exit_before_ready");
        }
        // The recovery surface owns the process until the validated dashboard
        // origin has been loaded. It is destroyed before any dashboard
        // renderer can become visible, so it cannot retain a stale origin.
        destroyRecoveryWindow();
        started = true;
        lifecycleActive = true;
        startDesktopStatusMonitor(ready.origin);
        return Object.freeze({ status: "ready", origin: ready.origin });
      } catch (error) {
        const status = recoveryStatusFor(
          error,
          startupUnexpectedExit ? "companion_exit_before_ready" : "companion_spawn_failed",
        );
        stopDesktopStatusMonitor();
        ready = null;
        destroyWindow();
        destroySettingsWindow();
        await supervisor.stop().catch(() => {});
        started = false;
        startupFailureStatus = status;
        if (quitting) throw error;
        showRecoveryWindow(status);
        // A companion failure is a recoverable application state. Keep the
        // menu/tray and process alive so Retry and Quit remain available.
        return Object.freeze({ status: "recovery", origin: null, failure: status });
      } finally {
        startupInProgress = false;
        startupAttemptPromise = null;
      }
    })();
    startupAttemptPromise.catch(() => {});
    return startupAttemptPromise;
  }

  async function start() {
    if (quitting) throw shellError("companion_not_running");
    if (started) return Object.freeze({ status: "ready", origin: ready?.origin ?? null });
    if (lifecycleActive) {
      return Object.freeze({
        status: "recovery",
        origin: null,
        failure: startupFailureStatus,
      });
    }
    if (singleInstanceLockAcquired) {
      primaryInstance = true;
    } else {
      if (typeof app.requestSingleInstanceLock === "function"
          && !app.requestSingleInstanceLock()) {
        app.quit?.();
        return Object.freeze({ status: "secondary_instance", origin: null });
      }
      primaryInstance = true;
    }
    lifecycleActive = true;
    listen(app, "second-instance", showWindow);
    listen(app, "activate", () => {
      if (window && !window.isDestroyed?.()) showWindow();
      else if (started) createWindow();
      else showRecoveryWindow(startupFailureStatus ?? "starting");
    });
    listen(app, "before-quit", (event) => {
      if (quitting) return;
      event?.preventDefault?.();
      void requestQuit();
    });
    // Keeping the app alive with its tray is intentional on every desktop.
    listen(app, "window-all-closed", () => {});
    try {
      await app.whenReady?.();
      if (quitting) throw shellError("companion_not_running");
      createApplicationMenu();
      createTray();
      // Create a visible, isolated launcher before asking the companion to
      // spawn. A timeout/early exit therefore leaves the user with a bounded
      // recovery path instead of a disappearing app.
      showRecoveryWindow("starting");
      return await attemptStartup();
    } catch (error) {
      destroyWindow();
      destroySettingsWindow();
      destroyRecoveryWindow();
      destroyTrayPopover();
      tray?.destroy?.();
      tray = null;
      await supervisor.stop().catch(() => {});
      lifecycleActive = false;
      // Only a composition/configuration failure reaches this boundary. A
      // companion startup failure is converted to a recovery result inside
      // attemptStartup and never calls app.quit here.
      if (quitting) app.quit?.();
      throw error instanceof Error && error.code?.startsWith("electron_shell_")
        ? error
        : shellError("companion_spawn_failed");
    } finally {
      startupInProgress = false;
    }
  }

  function performRetry({ epoch = lifecycleEpoch } = {}) {
    if (!lifecycleActive || quitting) return Promise.reject(shellError("companion_not_running"));
    const operation = enqueueExclusive(async () => {
      if (quitting || epoch !== lifecycleEpoch) throw shellError("companion_busy");
      stopDesktopStatusMonitor();
      destroyTrayPopover();
      destroyWindow();
      destroySettingsWindow();
      showRecoveryWindow("starting");
      ready = null;
      started = false;
      try {
        await supervisor.stop();
        if (quitting || epoch !== lifecycleEpoch) throw shellError("companion_busy");
        ready = await supervisor.start();
        if (quitting || epoch !== lifecycleEpoch) {
          await supervisor.stop().catch(() => {});
          ready = null;
          throw shellError("companion_busy");
        }
        createWindow();
        const dashboardLoad = dashboardLoadState;
        await dashboardLoad?.promise;
        if (dashboardLoad?.failed) {
          throw shellError("companion_spawn_failed");
        }
        destroyRecoveryWindow();
        started = true;
        startupFailureStatus = null;
        startDesktopStatusMonitor(ready.origin);
        showWindow();
        return Object.freeze({ status: "ready", origin: ready.origin });
      } catch (error) {
        if (quitting || epoch !== lifecycleEpoch) throw error;
        const status = recoveryStatusFor(error);
        stopDesktopStatusMonitor();
        ready = null;
        destroyWindow();
        destroySettingsWindow();
        await supervisor.stop().catch(() => {});
        started = false;
        startupFailureStatus = status;
        showRecoveryWindow(status);
        return Object.freeze({ status: "recovery", origin: null, failure: status });
      }
    });
    operation.catch(() => {});
    return operation;
  }

  function retry() {
    if (!lifecycleActive || quitting) return Promise.reject(shellError("companion_not_running"));
    if (startupAttemptPromise !== null) return startupAttemptPromise;
    // A user-directed Retry is a new bounded recovery attempt. The automatic
    // lane itself remains capped at one restart per child failure sequence.
    automaticRetryUsed = false;
    const epoch = lifecycleEpoch;
    if (retryPromise !== null) return retryPromise;
    retryPromise = performRetry({ epoch }).finally(() => {
      retryPromise = null;
    });
    retryPromise.catch(() => {});
    return retryPromise;
  }

  function scheduleAutomaticRetry({ status = "companion_exit_before_ready" } = {}) {
    if (!lifecycleActive || quitting || automaticRetryUsed || automaticRetryPromise !== null) {
      return;
    }
    automaticRetryUsed = true;
    const epoch = lifecycleEpoch;
    ready = null;
    destroyTrayPopover();
    // Invalidate the old webview synchronously before queueing the restart, so
    // no stale origin remains usable while the child is being replaced.
    destroyWindow();
    destroySettingsWindow();
    started = false;
    showRecoveryWindow(status);
    automaticRetryPromise = performRetry({ epoch }).finally(() => {
      automaticRetryPromise = null;
    });
    automaticRetryPromise.catch(() => {});
  }

  function handleUnexpectedCompanionExit() {
    if (quitting) return;
    if (!started) {
      if (!startupInProgress) return;
      // The supervisor can report a child exit after emitting its ready line
      // but before start() has published the lifecycle as ready.  Invalidate
      // and tear down any window created during that small startup window;
      // otherwise a stale-origin BrowserWindow could survive a failed launch.
      startupUnexpectedExit = true;
      stopDesktopStatusMonitor();
      ready = null;
      // A child can exit after the supervisor's ready line but while the
      // dashboard BrowserWindow is still awaiting loadURL(). Settle that
      // promise before destroying its window: start(), Retry, and Quit must
      // not remain hostage to a renderer load that can never finish.
      settleDashboardLoadFailure(dashboardLoadState, "companion_exit_before_ready");
      destroyWindow();
      destroySettingsWindow();
      startupFailureStatus = "companion_exit_before_ready";
      showRecoveryWindow("companion_exit_before_ready");
      return;
    }
    // Even after the one automatic retry has been consumed, no dead child may
    // leave its old-origin window usable. Manual tray Retry is the next path.
    stopDesktopStatusMonitor();
    ready = null;
    destroyWindow();
    destroySettingsWindow();
    started = false;
    showRecoveryWindow("companion_exit_before_ready");
    scheduleAutomaticRetry();
  }

  async function requestQuit() {
    if (shutdownPromise !== null) return shutdownPromise;
    quitting = true;
    ++lifecycleEpoch;
    stopDesktopStatusMonitor();
    const pendingStartup = startupAttemptPromise;
    shutdownPromise = enqueueExclusive(async () => {
      destroyWindow();
      destroySettingsWindow();
      destroyRecoveryWindow();
      destroyTrayPopover();
      // The supervisor owns the child created during its bounded startup
      // handshake. Wait for that handshake to settle before allowing Electron
      // to exit; otherwise a child that has not emitted its ready line could
      // outlive the GUI process.
      await pendingStartup?.catch(() => {});
      await supervisor.stop().catch(() => {});
      ownedDownloadsRegistry?.clear?.();
      tray?.destroy?.();
      tray = null;
      app.quit?.();
    });
    shutdownPromise.catch(() => {});
    return shutdownPromise;
  }

  async function dispose() {
    quitting = true;
    ++lifecycleEpoch;
    stopDesktopStatusMonitor();
    await enqueueExclusive(async () => {
      destroyWindow();
      destroySettingsWindow();
      destroyRecoveryWindow();
      destroyTrayPopover();
      tray?.destroy?.();
      tray = null;
      await supervisor.stop().catch(() => {});
      ownedDownloadsRegistry?.clear?.();
      supervisor.setUnexpectedExitHandler?.(undefined);
      for (const remove of listeners.splice(0)) remove();
      started = false;
      lifecycleActive = false;
      primaryInstance = false;
    });
  }

  if (typeof supervisor.setUnexpectedExitHandler === "function") {
    supervisor.setUnexpectedExitHandler(handleUnexpectedCompanionExit);
  }

  return Object.freeze({
    start,
    retry,
    showWindow,
    showSettingsWindow,
    hideWindow,
    toggleWindow,
    sendDashboardCommand,
    navigateDashboardSection,
    setDesktopLanguage,
    invokeTrayCommand,
    requestQuit,
    openDashboardInBrowser,
    dispose,
    createWindow,
    showTrayPopover,
    isAuthorizedDesktopSender,
    isAuthorizedDesktopFrame,
    isAuthorizedDashboardSender,
    isAuthorizedDashboardFrame,
    isAuthorizedCodexThreadNavigation,
    isAuthorizedSettingsFrame,
    isAuthorizedDesktopDownloadContext,
    revealLatestDownload() {
      if (ownedDownloadsRegistry === null) return Promise.resolve("unavailable");
      return ownedDownloadsRegistry.revealLatest();
    },
    get state() {
      return Object.freeze({
        started,
        quitting,
        primaryInstance,
        hasWindow: window !== null && !window.isDestroyed?.(),
        dashboardReady,
        windowVisible: window !== null
          && !window.isDestroyed?.()
          && window.isVisible?.() === true,
        hasRecoveryWindow: recovery !== null
          && !recovery.window?.isDestroyed?.(),
        recoveryWindowVisible: recovery !== null
          && !recovery.window?.isDestroyed?.()
          && recovery.window?.isVisible?.() === true,
        recoveryStatus,
        active: lifecycleActive,
        hasTray: tray !== null,
        hasSettingsWindow: settingsWindow !== null && !settingsWindow.isDestroyed?.(),
        settingsWindowVisible: settingsWindow !== null
          && !settingsWindow.isDestroyed?.()
          && settingsWindow.isVisible?.() === true,
        origin: ready?.origin ?? null,
      });
    },
  });
}
