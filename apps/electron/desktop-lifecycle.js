import { createLoopbackNavigationPolicy, installLoopbackNavigationPolicy } from "./loopback-policy.js";
import { shellError } from "./errors.js";

const DEFAULT_WINDOW_OPTIONS = Object.freeze({
  width: 1_180,
  height: 820,
  minWidth: 720,
  minHeight: 520,
});

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
  supervisor,
  preloadPath,
  icon,
  windowOptions = {},
  createNavigationPolicy = createLoopbackNavigationPolicy,
  installNavigationPolicy = installLoopbackNavigationPolicy,
  appName = "TiboTattle",
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

  let started = false;
  let quitting = false;
  let primaryInstance = false;
  let window = null;
  let tray = null;
  let ready = null;
  let policyInstallation = null;
  let windowListenerCleanup = null;
  let windowReadyListenerCleanup = null;
  let shutdownPromise = null;
  let retryPromise = null;
  let automaticRetryPromise = null;
  let automaticRetryUsed = false;
  let lifecycleEpoch = 0;
  let lifecycleOperation = Promise.resolve();
  const listeners = [];

  function listen(target, event, handler) {
    target.on(event, handler);
    listeners.push(() => target.off?.(event, handler));
  }

  function showWindow() {
    if (!window || window.isDestroyed?.()) return false;
    window.show?.();
    window.focus?.();
    return true;
  }

  function hideWindow() {
    if (!window || window.isDestroyed?.()) return false;
    window.hide?.();
    return true;
  }

  function toggleWindow() {
    if (!window || window.isDestroyed?.()) return false;
    if (window.isVisible?.()) return hideWindow();
    return showWindow();
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

  function enqueueExclusive(operation) {
    const previous = lifecycleOperation;
    const current = previous.catch(() => {}).then(operation);
    lifecycleOperation = current.catch(() => {});
    return current;
  }

  function destroyWindow() {
    windowReadyListenerCleanup?.();
    windowReadyListenerCleanup = null;
    windowListenerCleanup?.();
    windowListenerCleanup = null;
    policyInstallation?.remove?.();
    policyInstallation = null;
    if (window && !window.isDestroyed?.()) window.destroy?.();
    window = null;
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
    const webContents = window.webContents;
    const session = webContents?.session;
    const policy = createNavigationPolicy({ origin: ready.origin });
    policyInstallation = installNavigationPolicy({
      webContents,
      session,
      policy,
    });
    const onReadyToShow = () => showWindow();
    window.once?.("ready-to-show", onReadyToShow);
    windowReadyListenerCleanup = () => {
      window?.off?.("ready-to-show", onReadyToShow);
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
    const loadResult = window.loadURL?.(`${ready.origin}/`);
    loadResult?.catch?.(() => {});
    return window;
  }

  function createTray() {
    if (tray || typeof Tray !== "function") return tray;
    if (icon === undefined) throw shellError("electron_configuration_invalid");
    tray = new Tray(icon);
    tray.setToolTip?.(appName);
    const template = [
      { label: `Show ${appName}`, click: () => invokeTrayCommand("show") },
      { label: `Hide ${appName}`, click: () => invokeTrayCommand("hide") },
      { label: "Retry", click: () => retry() },
      { type: "separator" },
      { label: "Quit", click: () => { void requestQuit(); } },
    ];
    const menu = Menu?.buildFromTemplate?.(template);
    tray.setContextMenu?.(menu);
    tray.on?.("click", () => invokeTrayCommand("toggle"));
    return tray;
  }

  async function start() {
    if (quitting) throw shellError("companion_not_running");
    if (started) return Object.freeze({ status: "ready", origin: ready?.origin ?? null });
    if (typeof app.requestSingleInstanceLock === "function"
        && !app.requestSingleInstanceLock()) {
      app.quit?.();
      return Object.freeze({ status: "secondary_instance", origin: null });
    }
    primaryInstance = true;
    listen(app, "second-instance", showWindow);
    listen(app, "activate", () => {
      if (window && !window.isDestroyed?.()) showWindow();
      else if (started) createWindow();
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
      ready = await supervisor.start();
      if (quitting) {
        await supervisor.stop().catch(() => {});
        throw shellError("companion_not_running");
      }
      createWindow();
      createTray();
      started = true;
      return Object.freeze({ status: "ready", origin: ready.origin });
    } catch (error) {
      destroyWindow();
      tray?.destroy?.();
      tray = null;
      await supervisor.stop().catch(() => {});
      app.quit?.();
      throw error instanceof Error && error.code?.startsWith("electron_shell_")
        ? error
        : shellError("companion_spawn_failed");
    }
  }

  function performRetry({ epoch = lifecycleEpoch } = {}) {
    if (!started || quitting) return Promise.reject(shellError("companion_not_running"));
    const operation = enqueueExclusive(async () => {
      if (quitting || epoch !== lifecycleEpoch) throw shellError("companion_busy");
      destroyWindow();
      ready = null;
      await supervisor.stop();
      if (quitting || epoch !== lifecycleEpoch) throw shellError("companion_busy");
      ready = await supervisor.start();
      if (quitting || epoch !== lifecycleEpoch) {
        await supervisor.stop().catch(() => {});
        ready = null;
        throw shellError("companion_busy");
      }
      createWindow();
      showWindow();
      return Object.freeze({ status: "ready", origin: ready.origin });
    });
    operation.catch(() => {});
    return operation;
  }

  function retry() {
    if (!started || quitting) return Promise.reject(shellError("companion_not_running"));
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

  function scheduleAutomaticRetry() {
    if (!started || quitting || automaticRetryUsed || automaticRetryPromise !== null) {
      return;
    }
    automaticRetryUsed = true;
    const epoch = lifecycleEpoch;
    ready = null;
    // Invalidate the old webview synchronously before queueing the restart, so
    // no stale origin remains usable while the child is being replaced.
    destroyWindow();
    automaticRetryPromise = performRetry({ epoch }).finally(() => {
      automaticRetryPromise = null;
    });
    automaticRetryPromise.catch(() => {});
  }

  function handleUnexpectedCompanionExit() {
    if (!started || quitting) return;
    // Even after the one automatic retry has been consumed, no dead child may
    // leave its old-origin window usable. Manual tray Retry is the next path.
    ready = null;
    destroyWindow();
    scheduleAutomaticRetry();
  }

  async function requestQuit() {
    if (shutdownPromise !== null) return shutdownPromise;
    quitting = true;
    ++lifecycleEpoch;
    shutdownPromise = enqueueExclusive(async () => {
      destroyWindow();
      await supervisor.stop().catch(() => {});
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
    await enqueueExclusive(async () => {
      destroyWindow();
      tray?.destroy?.();
      tray = null;
      await supervisor.stop().catch(() => {});
      supervisor.setUnexpectedExitHandler?.(undefined);
      for (const remove of listeners.splice(0)) remove();
      started = false;
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
    hideWindow,
    toggleWindow,
    invokeTrayCommand,
    requestQuit,
    dispose,
    createWindow,
    get state() {
      return Object.freeze({
        started,
        quitting,
        primaryInstance,
        hasWindow: window !== null && !window.isDestroyed?.(),
        windowVisible: window !== null
          && !window.isDestroyed?.()
          && window.isVisible?.() === true,
        hasTray: tray !== null,
        origin: ready?.origin ?? null,
      });
    },
  });
}
