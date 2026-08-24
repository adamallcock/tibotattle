/**
 * The pre-companion recovery surface.
 *
 * This window is deliberately independent from the loopback dashboard. It is
 * loaded from a fixed data URL, uses an in-memory Electron session, and has a
 * one-way IPC vocabulary containing only Retry, Settings, and Quit. That lets
 * the desktop process stay alive when the private companion cannot produce a
 * ready line without giving a not-yet-authorized renderer a desktop bridge.
 */

import {
  desktopText,
  resolveDesktopLocale,
} from "./desktop-copy.js";

const RECOVERY_ACTIONS = Object.freeze(["retry", "settings", "quit"]);
const RECOVERY_STATUSES = Object.freeze([
  "starting",
  "companion_spawn_failed",
  "companion_start_timeout",
  "companion_exit_before_ready",
  "companion_ready_invalid",
  "companion_ready_overflow",
  "companion_shutdown_timeout",
  "companion_busy",
]);

export const RECOVERY_ACTION_CHANNEL = "tibotattle:electron-recovery:v1";
export const RECOVERY_WINDOW_VERSION = "v1";

const RECOVERY_COPY = Object.freeze({
  starting: Object.freeze({
    titleKey: "electron.recovery.starting.title",
    detailKey: "electron.recovery.starting.detail",
    code: "startup_in_progress",
  }),
  companion_spawn_failed: Object.freeze({
    titleKey: "electron.recovery.companionSpawnFailed.title",
    detailKey: "electron.recovery.companionSpawnFailed.detail",
    code: "companion_spawn_failed",
  }),
  companion_start_timeout: Object.freeze({
    titleKey: "electron.recovery.companionStartTimeout.title",
    detailKey: "electron.recovery.companionStartTimeout.detail",
    code: "companion_start_timeout",
  }),
  companion_exit_before_ready: Object.freeze({
    titleKey: "electron.recovery.companionExitBeforeReady.title",
    detailKey: "electron.recovery.companionExitBeforeReady.detail",
    code: "companion_exit_before_ready",
  }),
  companion_ready_invalid: Object.freeze({
    titleKey: "electron.recovery.companionReadyInvalid.title",
    detailKey: "electron.recovery.companionReadyInvalid.detail",
    code: "companion_ready_invalid",
  }),
  companion_ready_overflow: Object.freeze({
    titleKey: "electron.recovery.companionReadyOverflow.title",
    detailKey: "electron.recovery.companionReadyOverflow.detail",
    code: "companion_ready_overflow",
  }),
  companion_shutdown_timeout: Object.freeze({
    titleKey: "electron.recovery.companionShutdownTimeout.title",
    detailKey: "electron.recovery.companionShutdownTimeout.detail",
    code: "companion_shutdown_timeout",
  }),
  companion_busy: Object.freeze({
    titleKey: "electron.recovery.companionBusy.title",
    detailKey: "electron.recovery.companionBusy.detail",
    code: "companion_busy",
  }),
});

const RECOVERY_HTML_PREFIX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>TiboTattle</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7fb; color: #182033; }
main { width: min(420px, calc(100vw - 48px)); padding: 32px; border: 1px solid #dfe3ee; border-radius: 18px; background: #fff; box-shadow: 0 18px 48px rgb(23 32 56 / 12%); }
main:focus-visible, #detail:focus-visible { outline: 3px solid Highlight; outline-offset: 4px; }
h1 { margin: 0 0 12px; font-size: 24px; letter-spacing: -.02em; }
p { margin: 0; line-height: 1.5; }
.detail { color: #5f687d; }
.code { margin-top: 16px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #69738a; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 28px; }
button { appearance: none; border: 1px solid #b7bfd2; border-radius: 9px; padding: 9px 14px; background: #fff; color: inherit; font: inherit; cursor: pointer; }
button.primary { border-color: #2d5be3; background: #2d5be3; color: #fff; }
button:disabled { cursor: default; opacity: .45; }
@media (prefers-color-scheme: dark) {
  body { background: #171a22; color: #eef1fb; }
  main, button { background: #242936; border-color: #3b455b; }
  .detail, .code { color: #aeb8cf; }
}
</style>
</head>
<body>
<main aria-labelledby="title">
<h1 id="title">__TITLE__</h1>
<p class="detail" id="detail" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">__DETAIL__</p>
<p class="code" id="code">__DIAGNOSTIC__</p>
<div class="actions">
<button class="primary" id="retry" type="button">__RETRY__</button>
<button id="settings" type="button" __SETTINGS_DISABLED__>__SETTINGS__</button>
<button id="quit" type="button">__QUIT__</button>
</div>
</main>
<script>
(function () {
  const bridge = globalThis.tibotattleRecovery;
  const actions = Object.freeze({
    retry: document.getElementById("retry"),
    settings: document.getElementById("settings"),
    quit: document.getElementById("quit"),
  });
  for (const [name, button] of Object.entries(actions)) {
    button?.addEventListener("click", () => {
      if (typeof bridge?.[name] === "function") bridge[name]();
    });
  }
  // Each bounded status reload announces the current recovery action in a
  // deterministic place without moving focus to an actionable control.
  document.getElementById("detail")?.focus({ preventScroll: true });
}());
</script>
</body>
</html>`;

function assertStatus(status) {
  if (!RECOVERY_STATUSES.includes(status)) {
    throw new TypeError("recovery status is invalid");
  }
  return status;
}

function recoveryTextOptions({ locale = "system", systemLocales = [] } = {}) {
  return { locale, systemLocales };
}

function statusCopy(status, options = {}) {
  const selected = RECOVERY_COPY[assertStatus(status)];
  const textOptions = recoveryTextOptions(options);
  return Object.freeze({
    title: desktopText(selected.titleKey, {}, textOptions),
    detail: desktopText(selected.detailKey, {}, textOptions),
    code: selected.code,
    diagnostic: desktopText(
      "electron.recovery.diagnostic",
      { code: selected.code },
      textOptions,
    ),
  });
}

function escapeHTML(value) {
  return value.replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

export function recoveryStatusCopy(status, options = {}) {
  return statusCopy(status, options);
}

export function createRecoveryPageURL(status = "starting", options = {}) {
  const textOptions = recoveryTextOptions(options);
  const copy = statusCopy(status, textOptions);
  const locale = resolveDesktopLocale(
    textOptions.locale,
    textOptions.systemLocales,
  );
  const html = RECOVERY_HTML_PREFIX
    .replace('lang="en"', `lang="${escapeHTML(locale)}"`)
    .replaceAll("__TITLE__", escapeHTML(copy.title))
    .replaceAll("__DETAIL__", escapeHTML(copy.detail))
    .replaceAll("__DIAGNOSTIC__", escapeHTML(copy.diagnostic))
    .replaceAll(
      "__RETRY__",
      escapeHTML(desktopText("electron.recovery.retry", {}, textOptions)),
    )
    .replaceAll(
      "__SETTINGS__",
      escapeHTML(desktopText("electron.recovery.settings", {}, textOptions)),
    )
    .replaceAll(
      "__SETTINGS_DISABLED__",
      status === "starting" ? 'disabled aria-disabled="true"' : "",
    )
    .replaceAll(
      "__QUIT__",
      escapeHTML(desktopText("electron.recovery.quit", {}, textOptions)),
    );
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function validAction(value) {
  return typeof value === "string" && RECOVERY_ACTIONS.includes(value);
}

/**
 * Install the recovery window's local-only navigation and fixed IPC action
 * listener. The returned object owns all listeners and can be removed before
 * the BrowserWindow is destroyed.
 */
export function installRecoveryWindowPolicy({
  webContents,
  session: _session,
  initialURL,
  onAction,
} = {}) {
  if (!webContents || typeof webContents.on !== "function") {
    throw new TypeError("webContents is required");
  }
  if (typeof initialURL !== "string" || initialURL.length === 0) {
    throw new TypeError("initialURL is required");
  }
  if (typeof onAction !== "function") throw new TypeError("onAction is required");

  let allowedURL = initialURL;
  let removed = false;
  const onWillNavigate = (event, url) => {
    if (url !== allowedURL) event?.preventDefault?.();
  };
  const onWillRedirect = (event, url) => {
    if (url !== allowedURL) event?.preventDefault?.();
  };
  const onWillFrameNavigate = (event, details) => {
    const url = typeof details === "string" ? details : details?.url;
    const allowed = details?.isMainFrame === true && url === allowedURL;
    if (!allowed) event?.preventDefault?.();
  };
  const onWillAttachWebview = (event) => event?.preventDefault?.();
  const onIPCMessage = (event, channel, ...values) => {
    if (channel !== RECOVERY_ACTION_CHANNEL
        || event?.sender !== webContents
        || event?.frameId !== undefined && event.frameId !== 0
        || values.length !== 1
        || !validAction(values[0])) {
      return;
    }
    try {
      onAction(values[0]);
    } catch {
      // Recovery actions are fail-closed UI signals. The main lifecycle owns
      // the actual bounded operation and must not be disrupted by a callback.
    }
  };
  webContents.on("will-navigate", onWillNavigate);
  webContents.on("will-redirect", onWillRedirect);
  webContents.on("will-frame-navigate", onWillFrameNavigate);
  webContents.on("will-attach-webview", onWillAttachWebview);
  webContents.on("ipc-message", onIPCMessage);
  webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));

  return Object.freeze({
    setAllowedURL(url) {
      if (removed || typeof url !== "string" || url.length === 0) return false;
      allowedURL = url;
      return true;
    },
    remove() {
      if (removed) return;
      removed = true;
      webContents.off?.("will-navigate", onWillNavigate);
      webContents.off?.("will-redirect", onWillRedirect);
      webContents.off?.("will-frame-navigate", onWillFrameNavigate);
      webContents.off?.("will-attach-webview", onWillAttachWebview);
      webContents.off?.("ipc-message", onIPCMessage);
    },
  });
}

/**
 * Construct a secure, isolated BrowserWindow before the companion exists.
 */
export function createRecoveryWindow({
  BrowserWindow,
  preloadPath,
  status = "starting",
  windowOptions = {},
  onAction,
  locale = "system",
  systemLocales = [],
} = {}) {
  if (typeof BrowserWindow !== "function") throw new TypeError("BrowserWindow is required");
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    throw new TypeError("preloadPath is required");
  }
  if (typeof onAction !== "function") throw new TypeError("onAction is required");
  const textOptions = recoveryTextOptions({ locale, systemLocales });
  const initialURL = createRecoveryPageURL(status, textOptions);
  const suppliedOptions = windowOptions !== null
    && typeof windowOptions === "object"
    && !Array.isArray(windowOptions)
    ? windowOptions
    : {};
  const window = new BrowserWindow({
    width: 540,
    height: 430,
    minWidth: 460,
    minHeight: 360,
    ...suppliedOptions,
    webPreferences: {
      ...(suppliedOptions.webPreferences ?? {}),
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: "in-memory",
    },
    // The recovery surface must be visible while the private service is
    // starting; ready-to-show is not a valid readiness gate here.
    show: true,
    title: desktopText("electron.recovery.windowTitle", {}, textOptions),
  });
  const policy = installRecoveryWindowPolicy({
    webContents: window.webContents,
    session: window.webContents?.session,
    initialURL,
    onAction,
  });
  let currentStatus = assertStatus(status);
  let destroyed = false;
  const load = (nextStatus) => {
    if (destroyed || window.isDestroyed?.()) return false;
    currentStatus = assertStatus(nextStatus);
    const url = createRecoveryPageURL(currentStatus, textOptions);
    policy.setAllowedURL(url);
    const result = window.loadURL?.(url);
    result?.catch?.(() => {});
    return true;
  };
  // The window's initial navigation is explicit and uses the same bounded
  // URL that the policy approved before the load starts.
  const initialLoad = window.loadURL?.(initialURL);
  initialLoad?.catch?.(() => {});

  return Object.freeze({
    window,
    get status() {
      return currentStatus;
    },
    show() {
      if (destroyed || window.isDestroyed?.()) return false;
      window.show?.();
      window.focus?.();
      return true;
    },
    hide() {
      if (destroyed || window.isDestroyed?.()) return false;
      window.hide?.();
      return true;
    },
    setStatus: load,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      policy.remove();
      if (!window.isDestroyed?.()) window.destroy?.();
    },
    dispose() {
      destroyed = true;
      policy.remove();
    },
  });
}

export {
  RECOVERY_ACTIONS,
  RECOVERY_STATUSES,
};
