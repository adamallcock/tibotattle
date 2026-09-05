/**
 * The visual status surface opened by the Electron tray item.
 *
 * The native shell has a compact popover beside its menu-bar status item.
 * Electron's Tray API exposes a context menu, but it does not provide a
 * platform-neutral popover.  This module supplies the smallest equivalent:
 * a sandboxed, in-memory BrowserWindow whose data comes only from the
 * main-process tray projection.  It never reads renderer state or performs
 * accounting itself.
 */

import { existsSync } from "node:fs";

import { desktopText } from "./desktop-copy.js";
import {
  isAllowedCompanionURL,
  isExactLoopbackOrigin,
} from "./loopback-policy.js";
import {
  DESKTOP_TRAY_STATUS_STATES,
  projectDesktopTrayStatus,
  validateDesktopTrayStatus,
} from "./desktop-tray-status.js";

export const TRAY_POPOVER_VERSION = "v1";
export const TRAY_POPOVER_ACTION_CHANNEL = "tibotattle:electron-tray-popover:v1";
export const TRAY_POPOVER_MODEL_CHANNEL = "tibotattle:electron-tray-popover-model:v1";
export const TRAY_POPOVER_PRELOAD_FILE = "tray-popover-preload.cjs";
export const TRAY_POPOVER_ACTIONS = Object.freeze([
  "open",
  "weekly",
  "timeline",
  "accounting",
  "refresh",
  "settings",
  "quit",
]);

const STATUS_SET = new Set(DESKTOP_TRAY_STATUS_STATES);
const ACTION_SET = new Set(TRAY_POPOVER_ACTIONS);
const MAX_TEXT_BYTES = 512;
const MAX_WINDOWS = 2;
const POPOVER_WIDTH = 408;
const POPOVER_HEIGHT = 720;
const POPOVER_MIN_HEIGHT = 1;
const POPOVER_WORKAREA_MARGIN = 12;
const POPOVER_OFFSET = 8;
const TRAY_POPOVER_PAGE_PATH = "/electron-tray-popup.html";

function assertBoundedText(value, label) {
  if (typeof value !== "string"
      || value.length === 0
      || new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new TypeError(`${label} is invalid`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) {
      throw new TypeError(`${label} is invalid`);
    }
    if (codePoint === 0x7f) throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertAppName(value) {
  return assertBoundedText(value, "appName");
}

function assertTrayPopoverPageURL(value, origin) {
  if (!isExactLoopbackOrigin(origin)
      || typeof value !== "string"
      || !isAllowedCompanionURL(value, origin)) {
    throw new TypeError("tray popover page URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("tray popover page URL is invalid");
  }
  if (parsed.pathname !== TRAY_POPOVER_PAGE_PATH
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.href !== value) {
    throw new TypeError("tray popover page URL is invalid");
  }
  return parsed.href;
}

function freezeModel(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tray popover model must be an object");
  }
  const expected = [
    "version",
    "appName",
    "status",
    "statusLabel",
    "evidenceLabel",
    "compactTitle",
    "windows",
    "refreshEnabled",
    "hint",
  ];
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("tray popover model has unexpected fields");
  }
  if (value.version !== TRAY_POPOVER_VERSION || !STATUS_SET.has(value.status)) {
    throw new TypeError("tray popover model version or status is invalid");
  }
  assertAppName(value.appName);
  for (const [key, label] of [
    ["statusLabel", "statusLabel"],
    ["evidenceLabel", "evidenceLabel"],
    ["compactTitle", "compactTitle"],
    ["hint", "hint"],
  ]) assertBoundedText(value[key], label);
  if (typeof value.refreshEnabled !== "boolean") {
    throw new TypeError("tray popover refresh state is invalid");
  }
  if (!Array.isArray(value.windows) || value.windows.length > MAX_WINDOWS) {
    throw new TypeError("tray popover windows are invalid");
  }
  const windows = value.windows.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("tray popover window is invalid");
    }
    const keys = ["kind", "label", "remainingPercent"];
    const actualKeys = Reflect.ownKeys(item);
    if (actualKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) {
      throw new TypeError("tray popover window has unexpected fields");
    }
    if (item.kind !== "five_hour" && item.kind !== "seven_day") {
      throw new TypeError("tray popover window kind is invalid");
    }
    assertBoundedText(item.label, "window label");
    if (typeof item.remainingPercent !== "number"
        || !Number.isFinite(item.remainingPercent)
        || item.remainingPercent < 0
        || item.remainingPercent > 100) {
      throw new TypeError("tray popover window percentage is invalid");
    }
    return Object.freeze({
      kind: item.kind,
      label: item.label,
      remainingPercent: item.remainingPercent,
    });
  });
  return Object.freeze({
    version: TRAY_POPOVER_VERSION,
    appName: value.appName,
    status: value.status,
    statusLabel: value.statusLabel,
    evidenceLabel: value.evidenceLabel,
    compactTitle: value.compactTitle,
    windows: Object.freeze(windows),
    refreshEnabled: value.refreshEnabled,
    hint: value.hint,
  });
}

/**
 * Build the popover's closed view model from the already validated tray
 * status. The evidence object is projected immediately; no provider or
 * renderer fields cross this boundary.
 */
export function createDesktopTrayPopoverModel({
  appName = "TiboTattle",
  trayStatus,
  locale = "system",
  systemLocales = [],
  now = Date.now(),
} = {}) {
  const projected = projectDesktopTrayStatus(
    validateDesktopTrayStatus(trayStatus ?? {
      status: "unavailable",
      allowance: null,
      notificationEvidence: null,
    }),
    {
      localize: (key, values) => desktopText(key, values, { locale, systemLocales }),
      now,
    },
  );
  const windows = projected.windows.slice(0, MAX_WINDOWS).map((item) => Object.freeze({
    kind: item.durationMinutes === 10_080 ? "seven_day" : "five_hour",
    label: item.label,
    remainingPercent: item.remainingPercent,
  }));
  return freezeModel({
    version: TRAY_POPOVER_VERSION,
    appName: assertAppName(appName),
    status: projected.status,
    statusLabel: projected.label,
    evidenceLabel: projected.evidenceLabel,
    compactTitle: projected.compactTitle,
    windows,
    refreshEnabled: !["starting", "analyzing"].includes(projected.status),
    hint: desktopText("electron.trayPopover.dashboardHint", {}, { locale, systemLocales }),
  });
}

function validAction(value) {
  return typeof value === "string" && ACTION_SET.has(value);
}

/** Install the fixed, local-only action bridge for the popover renderer. */
export function installDesktopTrayPopoverPolicy({
  webContents,
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
  let removed = false;
  const onWillNavigate = (event, url) => {
    if (url !== initialURL) event?.preventDefault?.();
  };
  const onWillRedirect = (event, url) => {
    if (url !== initialURL) event?.preventDefault?.();
  };
  const onWillFrameNavigate = (event, details) => {
    const url = typeof details === "string" ? details : details?.url;
    if (details?.isMainFrame !== true || url !== initialURL) event?.preventDefault?.();
  };
  const onWillAttachWebview = (event) => event?.preventDefault?.();
  const isCommittedMainFrame = (event) => {
    const frame = event?.senderFrame;
    if (!frame || frame !== webContents.mainFrame) return false;
    if (Object.hasOwn(frame, "isMainFrame") && frame.isMainFrame !== true) return false;
    if (Object.hasOwn(frame, "parent") && frame.parent !== null) return false;
    if (typeof webContents.getURL !== "function") return false;
    try {
      return webContents.getURL() === initialURL;
    } catch {
      return false;
    }
  };
  const onIPCMessage = (event, channel, ...values) => {
    if (channel !== TRAY_POPOVER_ACTION_CHANNEL
        || event?.sender !== webContents
        || !isCommittedMainFrame(event)
        || values.length !== 1
        || !validAction(values[0])) return;
    try {
      onAction(values[0]);
    } catch {
      // The lifecycle owns each bounded action. Renderer failure must not
      // interrupt shutdown or the dashboard.
    }
  };
  webContents.on("will-navigate", onWillNavigate);
  webContents.on("will-redirect", onWillRedirect);
  webContents.on("will-frame-navigate", onWillFrameNavigate);
  webContents.on("will-attach-webview", onWillAttachWebview);
  webContents.on("ipc-message", onIPCMessage);
  webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
  return Object.freeze({
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

function isLiveWindow(value) {
  return value !== null && typeof value === "object" && value.isDestroyed?.() !== true;
}

function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeBounds(value) {
  if (value === null || typeof value !== "object") return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  // x/y may be negative on a display arranged to the left/above the primary
  // display. Only the extents must be positive for placement calculations.
  if ([x, y].some((item) => item === null)
      || [width, height].some((item) => item === null || item <= 0)) return null;
  return { x, y, width, height };
}

function matchingWorkArea(screen, bounds) {
  if (typeof screen?.getDisplayMatching !== "function") return null;
  try {
    return normalizeBounds(screen.getDisplayMatching(bounds)?.workArea);
  } catch {
    return null;
  }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Lazily construct and control the visual tray surface.  A missing preload in
 * a plain-Node composition simply disables this optional surface; the normal
 * context menu and dashboard remain available.
 */
export function createDesktopTrayPopover({
  BrowserWindow,
  preloadPath,
  pageURL,
  origin,
  tray,
  screen,
  platform = process.platform,
  model,
  onAction,
  windowOptions = {},
} = {}) {
  if (typeof BrowserWindow !== "function") throw new TypeError("BrowserWindow is required");
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    throw new TypeError("preloadPath is required");
  }
  const selectedPageURL = assertTrayPopoverPageURL(pageURL, origin);
  if (typeof onAction !== "function") throw new TypeError("onAction is required");
  let currentModel = freezeModel(model ?? createDesktopTrayPopoverModel());
  let window = null;
  let policy = null;
  let loaded = false;
  let pendingShow = false;
  let destroyed = false;
  let destroying = false;
  let windowCleanup = () => {};

  function present(bounds) {
    if (!isLiveWindow(window)) return false;
    const selectedBounds = normalizeBounds(bounds)
      ?? normalizeBounds(tray?.getBounds?.());
    if (selectedBounds !== null) {
      const size = window.getSize?.() ?? [POPOVER_WIDTH, POPOVER_HEIGHT];
      let width = finite(size?.[0], POPOVER_WIDTH);
      let height = finite(size?.[1], POPOVER_HEIGHT);
      const workArea = matchingWorkArea(screen, selectedBounds);
      if (workArea !== null) {
        // Keep the fixed-width surface usable on compact/high-DPI displays;
        // the page itself scrolls when this cap is below its natural height.
        width = Math.min(width, Math.max(1, Math.floor(
          workArea.width - (POPOVER_WORKAREA_MARGIN * 2),
        )));
        height = Math.min(height, Math.max(1, Math.floor(
          workArea.height - (POPOVER_WORKAREA_MARGIN * 2),
        )));
        if (typeof window.setSize === "function"
            && (width !== size?.[0] || height !== size?.[1])) {
          try {
            window.setSize(Math.round(width), Math.round(height), false);
          } catch {
            // Positioning below still receives the capped dimensions.
          }
        }
      }
      const centeredX = selectedBounds.x + (selectedBounds.width / 2) - (width / 2);
      const spaceAbove = selectedBounds.y - (workArea?.y ?? Number.NEGATIVE_INFINITY);
      const spaceBelow = workArea === null
        ? Number.POSITIVE_INFINITY
        : (workArea.y + workArea.height) - (selectedBounds.y + selectedBounds.height);
      const above = platform !== "darwin"
        && (spaceBelow < height + POPOVER_OFFSET || spaceAbove > spaceBelow);
      const anchoredY = above
        ? selectedBounds.y - height - POPOVER_OFFSET
        : selectedBounds.y + selectedBounds.height + POPOVER_OFFSET;
      let x = centeredX;
      let y = anchoredY;
      if (workArea !== null) {
        const insetX = Math.min(POPOVER_WORKAREA_MARGIN,
          Math.max(0, (workArea.width - width) / 2));
        const insetY = Math.min(POPOVER_WORKAREA_MARGIN,
          Math.max(0, (workArea.height - height) / 2));
        const minimumX = workArea.x + insetX;
        const maximumX = Math.max(minimumX, workArea.x + workArea.width - width - insetX);
        const minimumY = workArea.y + insetY;
        const maximumY = Math.max(minimumY, workArea.y + workArea.height - height - insetY);
        x = clamp(x, minimumX, maximumX);
        y = clamp(y, minimumY, maximumY);
      }
      try {
        window.setPosition?.(Math.round(x), Math.round(y), false);
      } catch {
        // A disappearing display can invalidate tray bounds during activation.
      }
    }
    try {
      // The popover is an interactive, keyboard-accessible surface. A
      // nonactivating panel would leave Escape and button focus with the
      // previous application, so explicitly activate and focus it.
      window.show?.();
      window.focus?.();
      pendingShow = false;
      return true;
    } catch {
      return false;
    }
  }

  function createWindow() {
    if (isLiveWindow(window)) return true;
    if (destroyed || !existsSync(preloadPath)) return false;
    const supplied = windowOptions !== null
      && typeof windowOptions === "object"
      && !Array.isArray(windowOptions)
      ? windowOptions
      : {};
    const options = {
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      minWidth: 1,
      maxWidth: POPOVER_WIDTH,
      minHeight: POPOVER_MIN_HEIGHT,
      maxHeight: POPOVER_HEIGHT,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: currentModel.appName,
      backgroundColor: "#f5f7f5",
      ...supplied,
      webPreferences: {
        ...(supplied.webPreferences ?? {}),
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: "in-memory",
      },
      ...(platform === "darwin" ? { type: "panel" } : {}),
    };
    try {
      window = new BrowserWindow(options);
    } catch {
      window = null;
      return false;
    }
    const candidate = window;
    const initialURL = selectedPageURL;
    try {
      policy = installDesktopTrayPopoverPolicy({
        webContents: candidate.webContents,
        initialURL,
        onAction: (action) => {
          try {
            onAction(action);
          } finally {
            hide();
          }
        },
      });
    } catch {
      candidate.destroy?.();
      window = null;
      return false;
    }
    const onBlur = () => {
      if (!destroying) hide();
    };
    const onBeforeInputEvent = (_event, input) => {
      if (input?.type === "keyDown" && input.key === "Escape") hide();
    };
    const onClosed = () => {
      if (window !== candidate) return;
      windowCleanup();
      window = null;
      policy = null;
      loaded = false;
      pendingShow = false;
    };
    candidate.on?.("blur", onBlur);
    candidate.on?.("closed", onClosed);
    candidate.webContents?.on?.("before-input-event", onBeforeInputEvent);
    windowCleanup = () => {
      candidate.off?.("blur", onBlur);
      candidate.off?.("closed", onClosed);
      candidate.webContents?.off?.("before-input-event", onBeforeInputEvent);
      policy?.remove?.();
      policy = null;
    };
    try {
      const loadResult = candidate.loadURL?.(initialURL);
      Promise.resolve(loadResult).then(
        () => {
          if (window !== candidate || destroyed) return;
          loaded = true;
          if (pendingShow) present();
        },
        () => {
          if (window !== candidate) return;
          loaded = false;
        },
      );
    } catch {
      loaded = false;
    }
    return true;
  }

  function setModel(nextModel) {
    if (destroyed) return false;
    currentModel = freezeModel(nextModel);
    if (isLiveWindow(window) && typeof window.webContents?.send === "function") {
      try {
        window.webContents.send(TRAY_POPOVER_MODEL_CHANNEL, currentModel);
      } catch {
        return false;
      }
    }
    return true;
  }

  function show(bounds) {
    if (destroyed) return false;
    if (!createWindow()) return false;
    pendingShow = true;
    return loaded ? present(bounds) : true;
  }

  function hide() {
    pendingShow = false;
    if (!isLiveWindow(window)) return false;
    try {
      window.hide?.();
      return true;
    } catch {
      return false;
    }
  }

  function toggle(bounds) {
    if (isLiveWindow(window) && window.isVisible?.() === true) {
      hide();
      return true;
    }
    return show(bounds);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    pendingShow = false;
    destroying = true;
    windowCleanup();
    const candidate = window;
    window = null;
    loaded = false;
    if (candidate && !candidate.isDestroyed?.()) {
      try {
        candidate.destroy?.();
      } catch {
        // Shutdown continues through the primary tray/lifecycle path.
      }
    }
    destroying = false;
  }

  return Object.freeze({
    setModel,
    show,
    hide,
    toggle,
    destroy,
    get available() {
      return !destroyed && existsSync(preloadPath) && selectedPageURL !== null;
    },
    get visible() {
      return isLiveWindow(window) && window.isVisible?.() === true;
    },
  });
}
