/**
 * Dependency-injected tray descriptors for the Electron shell.
 *
 * The information rows are derived only from the main process's closed status
 * contract. The tray never infers freshness or quota state from renderer data.
 */

import { isAbsolute, join } from "node:path";
import { deflateSync } from "node:zlib";

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
// Keep the intermediate bitmap large enough to preserve the bird's fingers
// and beak before reducing it to the 16px menu-bar mark. The native AppKit
// implementation uses the same 64px extraction surface.
const TRAY_TEMPLATE_WORK_SIZE = 64;
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
  platform = process.platform,
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

  const macOS = platform === "darwin";
  const headerSubLabel = projectedStatus.status === "analyzing"
    ? projectedStatus.label
    : projectedStatus.evidenceLabel;
  // Match the native menu-bar action's lifecycle truth. A refresh is useful
  // only once the companion has become ready; while a pass is active it must
  // not invite a second overlapping request, and an unavailable companion
  // gets the recovery action directly instead of a misleading update label.
  const refreshAction = projectedStatus.status === "starting"
    ? {
      label: desktopText("electron.tray.statusStarting", {}, textOptions),
      enabled: false,
    }
    : projectedStatus.status === "analyzing"
      ? {
        label: desktopText("electron.tray.statusAnalyzing", {}, textOptions),
        enabled: false,
      }
      : projectedStatus.status === "unavailable"
        ? {
          label: desktopText("electron.tray.retry", {}, textOptions),
          click: boundedActions.retry,
        }
        : {
          label: desktopText("electron.tray.refresh", {}, textOptions),
          click: boundedActions.refresh,
          accelerator: "CmdOrCtrl+R",
        };
  // Electron maps `sublabel` to AppKit's native secondary line. Keep the
  // second disabled item as a hidden compatibility row so older injected
  // callers/tests that inspect the fallback shape remain safe; it is visible
  // on Windows/Linux where sublabel is not a supported native presentation.
  const template = [
    {
      label: desktopText("electron.tray.allowanceTitle", {
        appName,
        allowance: projectedStatus.compactTitle,
      }, textOptions),
      enabled: false,
      ...(macOS ? { sublabel: headerSubLabel } : {}),
    },
    {
      label: headerSubLabel,
      enabled: false,
      ...(macOS ? { visible: false } : {}),
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
      label: desktopText("electron.tray.weekly", {}, textOptions),
      click: boundedActions.weekly,
    },
    {
      label: desktopText("electron.tray.timeline", {}, textOptions),
      click: boundedActions.timeline,
    },
    {
      label: desktopText("electron.tray.accounting", {}, textOptions),
      click: boundedActions.accounting,
    },
    refreshAction,
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
  if (projectedStatus.status === "stale") {
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

function pngChunk(type, data) {
  const label = Buffer.from(type, "ascii");
  const payload = Buffer.concat([label, data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  payload.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return output;
}

/**
 * Encode the extracted BGRA bitmap as a tiny PNG fallback.
 *
 * Electron documents `createFromBitmap` as platform-dependent raw pixels.
 * The primary path below uses a format-validated PNG through
 * `createFromBuffer`, which keeps alpha semantics stable across platforms.
 * The raw bitmap path remains a fallback for runtimes without a PNG decoder.
 */
function encodeDesktopTrayTemplatePNG(bitmap) {
  const width = TRAY_TEMPLATE_WORK_SIZE;
  const height = TRAY_TEMPLATE_WORK_SIZE;
  const rowBytes = width * 4;
  const scanlines = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * rowBytes;
    const targetRow = y * (rowBytes + 1);
    // Filter 0 keeps the fallback decoder independent of any PNG predictor.
    scanlines[targetRow] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 4;
      const target = targetRow + 1 + x * 4;
      scanlines[target] = bitmap[source + 2];
      scanlines[target + 1] = bitmap[source + 1];
      scanlines[target + 2] = bitmap[source];
      scanlines[target + 3] = bitmap[source + 3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function resizedTemplateImage(nativeImage, bitmap) {
  const extracted = extractDesktopTrayTemplateBitmap(bitmap);
  if (extracted === undefined) return null;
  const options = {
    width: TRAY_TEMPLATE_WORK_SIZE,
    height: TRAY_TEMPLATE_WORK_SIZE,
    scaleFactor: 1,
  };
  const resizeTemplate = (source) => {
    if (source === null
        || typeof source !== "object"
        || typeof source.resize !== "function") return null;
    let resized;
    try {
      resized = source.resize({
        width: TRAY_ICON_SIZE,
        height: TRAY_ICON_SIZE,
        quality: "best",
      });
    } catch {
      return null;
    }
    return isNonEmptyNativeImage(resized) ? resized : null;
  };
  if (typeof nativeImage?.createFromBuffer === "function") {
    try {
      const source = nativeImage.createFromBuffer(
        encodeDesktopTrayTemplatePNG(extracted),
        { scaleFactor: 1 },
      );
      const resized = resizeTemplate(source);
      if (resized !== null) return resized;
    } catch {
      // Fall through to the raw bitmap decoder below.
    }
  }
  if (typeof nativeImage?.createFromBitmap === "function") {
    try {
      const source = nativeImage.createFromBitmap(extracted, options);
      const resized = resizeTemplate(source);
      if (resized !== null) return resized;
    } catch {
      // The caller retains the non-empty source image as a final fail-soft
      // fallback, so a renderer cannot lose its tray entry on this path.
    }
  }
  return null;
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
  // Electron/nativeImage implementations still fail soft to the unprocessed
  // asset rather than losing the status item entirely.
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
      && (typeof nativeImage.createFromBitmap === "function"
        || typeof nativeImage.createFromBuffer === "function")) {
    try {
      const bitmap = Buffer.from(resized.toBitmap());
      const template = resizedTemplateImage(nativeImage, bitmap);
      if (template !== null) resized = template;
    } catch {
      // Keep the non-empty resized source and mark it as a template below.
      // A runtime-specific bitmap conversion failure must not remove the
      // status item altogether; the PNG fallback above handles runtimes that
      // reject createFromBitmap while this path protects older ones that do
      // not expose either conversion helper.
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

/**
 * Extract the bright bird from an Electron BGRA bitmap.
 *
 * The native status item uses the source artwork's red channel as the
 * reviewed separation between the deep-green plate and the cream/amber bird:
 * values around 0.35 are transparent and values around 0.75 are opaque. A
 * ramp, rather than a hard threshold, preserves anti-aliased edges while the
 * source alpha keeps transparent icon corners transparent. The helper is
 * exported so the real packaged asset can be regression-tested without
 * needing a running Electron process.
 */
export function extractDesktopTrayTemplateBitmap(bitmap) {
  if (!(bitmap instanceof Uint8Array)
      || bitmap.byteLength !== TRAY_TEMPLATE_WORK_SIZE * TRAY_TEMPLATE_WORK_SIZE * 4) {
    return undefined;
  }
  const output = Buffer.from(bitmap);
  for (let offset = 0; offset < output.length; offset += 4) {
    // Electron nativeImage.toBitmap() is BGRA on the supported desktop
    // targets. This intentionally mirrors the native Swift red-channel ramp.
    const red = output[offset + 2];
    const sourceAlpha = output[offset + 3];
    const markAlpha = Math.max(
      0,
      Math.min(1, (red / 255 - 0.35) / 0.40),
    );
    output[offset] = 255;
    output[offset + 1] = 255;
    output[offset + 2] = 255;
    output[offset + 3] = Math.round(sourceAlpha * markAlpha);
  }
  return output;
}

export {
  STATUS_PLACEHOLDER,
  TRAY_ICON_RELATIVE_PATH,
  TRAY_ICON_SIZE,
  TRAY_TEMPLATE_CROP_INSET_RATIO,
  TRAY_TEMPLATE_CROP_SIZE_RATIO,
  TRAY_TEMPLATE_WORK_SIZE,
};
