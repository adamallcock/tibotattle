/**
 * Dependency-injected tray descriptors for the Electron shell.
 *
 * The information rows are derived only from the main process's closed status
 * contract. The tray never infers freshness or quota state from renderer data.
 */

import { isAbsolute, join } from "node:path";

import {
  createDesktopActionInterface,
  desktopText,
  getDesktopOptionalAction,
} from "./desktop-menu.js";
import {
  projectDesktopTrayStatus,
  validateDesktopTrayStatus,
} from "./desktop-tray-status.js";

const STATUS_PLACEHOLDER = "Status unavailable";
const TRAY_ICON_RELATIVE_PATH = "apps/web/public/tibotattle-icon.png";
const TRAY_ICON_SIZE = 16;
const TRAY_TEMPLATE_WORK_SIZE = 32;
const TRAY_TEMPLATE_CROP_INSET_RATIO = 0.14;
const TRAY_TEMPLATE_CROP_SIZE_RATIO = 0.72;

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
  now = Date.now(),
} = {}) {
  if (typeof appName !== "string" || appName.trim().length === 0) {
    throw new TypeError("appName is required");
  }
  const boundedActions = createDesktopActionInterface(actions);
  const checkForUpdates = getDesktopOptionalAction(
    boundedActions,
    "checkForUpdates",
  );
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
        now,
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
      compactTitle: "–",
      evidenceLabel: statusLabel,
      windows: Object.freeze([]),
    });
  } else {
    // Preserve the previous default: an unconnected tray is unavailable
    // until a main-process status controller supplies a snapshot.
    projectedStatus = projectDesktopTrayStatus(
      { status: "unavailable", allowance: null, notificationEvidence: null },
      {
        localize: (key, values) => desktopText(key, values, textOptions),
        now,
      },
    );
  }

  const template = [
    {
      label: desktopText("electron.tray.allowanceTitle", {
        appName,
        allowance: projectedStatus.compactTitle,
      }, textOptions),
      enabled: false,
    },
    {
      label: projectedStatus.evidenceLabel,
      enabled: false,
    },
  ];
  for (const window of projectedStatus.windows ?? []) {
    template.push({
      label: window.label,
      enabled: false,
    });
  }
  template.push(
    { type: "separator" },
    {
      label: desktopText("electron.tray.open", { appName }, textOptions),
      click: boundedActions.show,
    },
    {
      label: desktopText("electron.tray.refresh", {}, textOptions),
      click: boundedActions.refresh,
      accelerator: "CmdOrCtrl+R",
    },
    // Keep the native status-menu affordance visible even in the Electron
    // development shell, where no updater action is wired. A disabled item
    // makes the capability boundary explicit without pretending that a check
    // happened or allowing a click to cross into an unowned updater path.
    {
      label: desktopText("electron.tray.checkForUpdates", {}, textOptions),
      enabled: checkForUpdates !== null,
      ...(checkForUpdates === null ? {} : { click: checkForUpdates }),
    },
    {
      label: desktopText("electron.tray.settings", {}, textOptions),
      click: boundedActions.settings,
      accelerator: "CmdOrCtrl+,",
    },
    {
      label: desktopText("electron.tray.about", { appName }, textOptions),
      click: boundedActions.about,
    },
    { type: "separator" },
    {
      label: desktopText("electron.tray.quit", { appName }, textOptions),
      click: boundedActions.quit,
      accelerator: "CmdOrCtrl+Q",
    },
  );
  if (["stale", "unavailable"].includes(projectedStatus.status)) {
    const settingsIndex = template.findIndex((entry) => entry.accelerator === "CmdOrCtrl+,");
    template.splice(settingsIndex, 0, {
      label: desktopText("electron.tray.retry", {}, textOptions),
      click: boundedActions.retry,
    });
  }
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

  // The reviewed application artwork is a full squircle. At menu-bar size,
  // shrinking that whole plate makes the cream bird collapse into a white
  // rounded square. Match the native AppKit shell's reviewed crop before
  // extracting the bright brand mark. The crop seam is optional so older
  // Electron/nativeImage implementations still fail soft to the previous
  // thresholding path rather than losing the status item entirely.
  let workingSource = source;
  if (platform === "darwin"
      && typeof source.getSize === "function"
      && typeof source.crop === "function") {
    try {
      const size = source.getSize();
      const width = Number(size?.width);
      const height = Number(size?.height);
      if (Number.isFinite(width) && Number.isFinite(height)
          && width > 0 && height > 0) {
        const cropWidth = Math.max(1, Math.round(width * TRAY_TEMPLATE_CROP_SIZE_RATIO));
        const cropHeight = Math.max(1, Math.round(height * TRAY_TEMPLATE_CROP_SIZE_RATIO));
        const cropped = source.crop({
          x: Math.max(0, Math.floor(width * TRAY_TEMPLATE_CROP_INSET_RATIO)),
          y: Math.max(0, Math.floor(height * TRAY_TEMPLATE_CROP_INSET_RATIO)),
          width: Math.min(Math.round(width), cropWidth),
          height: Math.min(Math.round(height), cropHeight),
        });
        if (isNonEmptyNativeImage(cropped) && typeof cropped.resize === "function") {
          workingSource = cropped;
        }
      }
    } catch {
      workingSource = source;
    }
  }

  let resized;
  try {
    const size = platform === "darwin" ? TRAY_TEMPLATE_WORK_SIZE : TRAY_ICON_SIZE;
    resized = workingSource.resize({
      width: size,
      height: size,
      quality: "best",
    });
  } catch {
    return undefined;
  }
  if (!isNonEmptyNativeImage(resized)) return undefined;

  if (platform === "darwin"
      && typeof resized.toBitmap === "function"
      && typeof nativeImage.createFromBitmap === "function") {
    try {
      const bitmap = Buffer.from(resized.toBitmap());
      if (bitmap.length !== TRAY_TEMPLATE_WORK_SIZE * TRAY_TEMPLATE_WORK_SIZE * 4) {
        return undefined;
      }
      for (let offset = 0; offset < bitmap.length; offset += 4) {
        const blue = bitmap[offset];
        const green = bitmap[offset + 1];
        const red = bitmap[offset + 2];
        const sourceAlpha = bitmap[offset + 3];
        const brightness = Math.max(red, green, blue);
        const markAlpha = Math.max(0, Math.min(255, (brightness - 130) * 4));
        bitmap[offset] = 255;
        bitmap[offset + 1] = 255;
        bitmap[offset + 2] = 255;
        bitmap[offset + 3] = Math.round((sourceAlpha * markAlpha) / 255);
      }
      const templateSource = nativeImage.createFromBitmap(bitmap, {
        width: TRAY_TEMPLATE_WORK_SIZE,
        height: TRAY_TEMPLATE_WORK_SIZE,
        scaleFactor: 1,
      });
      resized = templateSource.resize({
        width: TRAY_ICON_SIZE,
        height: TRAY_ICON_SIZE,
        quality: "best",
      });
    } catch {
      return undefined;
    }
  }

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
  TRAY_TEMPLATE_CROP_INSET_RATIO,
  TRAY_TEMPLATE_CROP_SIZE_RATIO,
  TRAY_TEMPLATE_WORK_SIZE,
};
