/**
 * Dependency-injected tray descriptors for the Electron shell.
 *
 * The status row is deliberately disabled and fixed: the tray module does
 * not infer dashboard freshness or quota state from renderer data.  A future
 * main-process status controller can replace this descriptor through an
 * explicitly reviewed integration.
 */

import { isAbsolute, join } from "node:path";

import {
  createDesktopActionInterface,
  desktopText,
} from "./desktop-menu.js";
import {
  projectDesktopTrayStatus,
  validateDesktopTrayStatus,
} from "./desktop-tray-status.js";

const STATUS_PLACEHOLDER = "Status unavailable";
const TRAY_ICON_RELATIVE_PATH = "apps/web/public/tibotattle-icon.png";
const TRAY_ICON_SIZE = 16;

function defaultSystemLocales() {
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return ["en-US"];
  }
}

export function createDesktopTrayTemplate({
  appName = "TiboTattle",
  actions = createDesktopActionInterface(),
  trayStatus,
  statusLabel,
  locale = "system",
  systemLocales = defaultSystemLocales(),
} = {}) {
  if (typeof appName !== "string" || appName.trim().length === 0) {
    throw new TypeError("appName is required");
  }
  const boundedActions = createDesktopActionInterface(actions);
  const textOptions = { locale, systemLocales };
  let projectedStatus;
  if (trayStatus !== undefined) {
    if (statusLabel !== undefined) {
      throw new TypeError("statusLabel cannot override trayStatus");
    }
    // The status object is deliberately validated at this main-process
    // boundary.  It accepts only the closed semantic contract and never
    // turns renderer labels, paths, errors, or identity data into menu copy.
    projectedStatus = projectDesktopTrayStatus(
      validateDesktopTrayStatus(trayStatus),
      {
        localize: (key, values) => desktopText(key, values, textOptions),
      },
    );
  } else if (statusLabel !== undefined) {
    // Keep the old dependency-injected label seam for existing callers that
    // have not adopted the semantic status object yet.  New callers should
    // pass `trayStatus`; this compatibility path cannot carry an allowance
    // row and is never populated from renderer data.
    if (typeof statusLabel !== "string" || statusLabel.trim().length === 0) {
      throw new TypeError("statusLabel is required");
    }
    projectedStatus = Object.freeze({
      status: "unavailable",
      label: statusLabel,
      allowance: null,
    });
  } else {
    // Preserve the previous default: an unconnected tray is unavailable
    // until a main-process status controller supplies a snapshot.
    projectedStatus = projectDesktopTrayStatus(
      { status: "unavailable", allowance: null },
      {
        localize: (key, values) => desktopText(key, values, textOptions),
      },
    );
  }

  const template = [
    {
      label: desktopText("electron.tray.open", { appName }, textOptions),
      click: boundedActions.show,
    },
    {
      label: projectedStatus.label,
      enabled: false,
    },
  ];
  if (projectedStatus.allowance !== null) {
    template.push({
      label: projectedStatus.allowance.label,
      enabled: false,
    });
  }
  template.push(
    { type: "separator" },
    {
      label: desktopText("electron.tray.refresh", {}, textOptions),
      click: boundedActions.refresh,
    },
    {
      label: desktopText("electron.tray.retry", {}, textOptions),
      click: boundedActions.retry,
    },
    { type: "separator" },
    {
      label: desktopText("electron.tray.settings", {}, textOptions),
      click: boundedActions.settings,
    },
    {
      label: desktopText("electron.tray.about", { appName }, textOptions),
      click: boundedActions.about,
    },
    { type: "separator" },
    {
      label: desktopText("electron.tray.quit", {}, textOptions),
      click: boundedActions.quit,
    },
  );
  return template;
}

function isNonEmptyNativeImage(value) {
  if (value === null || typeof value !== "object") return false;
  if (typeof value.isEmpty !== "function") return false;
  try {
    return value.isEmpty() === false;
  } catch {
    return false;
  }
}

/**
 * Resolve the reviewed tray asset from the trusted application root.
 *
 * `resourceRoot` is supplied by the main process after it has resolved the
 * packaged application path. The resolver deliberately accepts no arbitrary
 * asset path: the only file it can load is the fixed, packaged brand asset.
 * An explicitly injected `icon` remains available for dependency-injected
 * tests and callers that already own a validated NativeImage.
 */
export function resolveDesktopTrayIcon({
  nativeImage,
  resourceRoot,
  platform = process.platform,
  icon,
} = {}) {
  if (icon !== undefined) return icon;
  if (typeof nativeImage?.createFromPath !== "function") return undefined;
  if (typeof resourceRoot !== "string" || !isAbsolute(resourceRoot)) {
    return undefined;
  }

  const iconPath = join(resourceRoot, TRAY_ICON_RELATIVE_PATH);
  let source;
  try {
    source = nativeImage.createFromPath(iconPath);
  } catch {
    return undefined;
  }
  if (!isNonEmptyNativeImage(source) || typeof source.resize !== "function") {
    return undefined;
  }

  let resized;
  try {
    resized = source.resize({
      width: TRAY_ICON_SIZE,
      height: TRAY_ICON_SIZE,
      quality: "best",
    });
  } catch {
    return undefined;
  }
  if (!isNonEmptyNativeImage(resized)) return undefined;

  if (platform === "darwin" && typeof resized.setTemplateImage === "function") {
    try {
      resized.setTemplateImage(true);
    } catch {
      return undefined;
    }
  }
  return resized;
}

export {
  STATUS_PLACEHOLDER,
  TRAY_ICON_RELATIVE_PATH,
  TRAY_ICON_SIZE,
};
