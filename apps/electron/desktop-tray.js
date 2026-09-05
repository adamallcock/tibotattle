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
const TRAY_TEMPLATE_SCALE_FACTORS = Object.freeze([1, 2]);
const TRAY_TEMPLATE_DRAW_SCALE = TRAY_TEMPLATE_WORK_SIZE / TRAY_ICON_SIZE;
const NATIVE_TRAY_BIRD_RECT = Object.freeze({
  x: 0.5,
  y: 2.5,
  width: 15,
  height: 12.5,
});
const NATIVE_TRAY_METER_RECT = Object.freeze({
  x: 1.5,
  y: 0.25,
  width: 13,
  height: 1.75,
});

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

function resizeTemplate(source) {
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
}

function templateSourceFromBitmap(nativeImage, bitmap) {
  if (!(bitmap instanceof Uint8Array)
      || bitmap.byteLength !== TRAY_TEMPLATE_WORK_SIZE * TRAY_TEMPLATE_WORK_SIZE * 4) {
    return null;
  }
  const options = {
    width: TRAY_TEMPLATE_WORK_SIZE,
    height: TRAY_TEMPLATE_WORK_SIZE,
    scaleFactor: 1,
  };
  if (typeof nativeImage?.createFromBuffer === "function") {
    try {
      const source = nativeImage.createFromBuffer(
        encodeDesktopTrayTemplatePNG(bitmap),
        { scaleFactor: 1 },
      );
      if (source !== null
          && typeof source === "object"
          && typeof source.resize === "function") return source;
    } catch {
      // Fall through to the raw bitmap decoder below.
    }
  }
  if (typeof nativeImage?.createFromBitmap === "function") {
    try {
      const source = nativeImage.createFromBitmap(bitmap, options);
      if (source !== null
          && typeof source === "object"
          && typeof source.resize === "function") return source;
    } catch {
      // The caller retains the already-decoded app asset as a final fallback.
    }
  }
  return null;
}

function markTemplateImage(image) {
  if (image === undefined || image === null || typeof image !== "object") return image;
  if (typeof image.setTemplateImage === "function") {
    try {
      image.setTemplateImage(true);
    } catch {
      return null;
    }
  }
  return image;
}

/**
 * Build the exact 16pt tray mark with distinct 1x and Retina bitmaps.
 *
 * Resizing a 64px source directly to a 16px scale-1 NativeImage leaves
 * AppKit no 2x backing to select, so macOS enlarges that one representation
 * on a Retina menu bar.  Use Electron's representation API to retain the
 * same reviewed mark at both physical sizes.  The source remains the
 * PNG-decoded 64px alpha template above; this helper never draws new art.
 */
function highDensityTemplateImage(nativeImage, source) {
  if (typeof nativeImage?.createEmpty !== "function"
      || source === null
      || typeof source !== "object"
      || typeof source.resize !== "function") return null;

  let template;
  try {
    template = nativeImage.createEmpty();
  } catch {
    return null;
  }
  if (template === null
      || typeof template !== "object"
      || typeof template.addRepresentation !== "function") return null;

  for (const scaleFactor of TRAY_TEMPLATE_SCALE_FACTORS) {
    const pixelSize = TRAY_ICON_SIZE * scaleFactor;
    let representation;
    try {
      representation = source.resize({
        width: pixelSize,
        height: pixelSize,
        quality: "best",
      });
      if (!isNonEmptyNativeImage(representation)
          || typeof representation.toBitmap !== "function") return null;
      const buffer = Buffer.from(representation.toBitmap());
      if (buffer.byteLength !== pixelSize * pixelSize * 4) return null;
      template.addRepresentation({
        scaleFactor,
        width: pixelSize,
        height: pixelSize,
        buffer,
      });
    } catch {
      return null;
    }
  }
  return isNonEmptyNativeImage(template) ? template : null;
}

function finalizeTemplateSource(nativeImage, source) {
  return highDensityTemplateImage(nativeImage, source) ?? resizeTemplate(source);
}

function scaledNativeRect(rect) {
  const scale = TRAY_TEMPLATE_DRAW_SCALE;
  return {
    x: rect.x * scale,
    // Native AppKit coordinates begin at the lower-left; Electron bitmaps
    // are top-down. Keep the reviewed 16pt geometry exactly when composing
    // the 64px extraction surface.
    y: TRAY_TEMPLATE_WORK_SIZE - (rect.y + rect.height) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function insideRoundedRect(x, y, rect, radius) {
  const boundedRadius = clamp(radius, 0, Math.min(rect.width, rect.height) / 2);
  const centerX = clamp(x, rect.x + boundedRadius, rect.x + rect.width - boundedRadius);
  const centerY = clamp(y, rect.y + boundedRadius, rect.y + rect.height - boundedRadius);
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  return deltaX * deltaX + deltaY * deltaY <= boundedRadius * boundedRadius;
}

function paintShape(bitmap, bounds, predicate, alpha) {
  const boundedAlpha = clamp(alpha, 0, 1);
  if (boundedAlpha === 0) return;
  const samples = [0.25, 0.75];
  const minX = clamp(Math.floor(bounds.x), 0, TRAY_TEMPLATE_WORK_SIZE - 1);
  const maxX = clamp(Math.ceil(bounds.x + bounds.width) - 1, 0, TRAY_TEMPLATE_WORK_SIZE - 1);
  const minY = clamp(Math.floor(bounds.y), 0, TRAY_TEMPLATE_WORK_SIZE - 1);
  const maxY = clamp(Math.ceil(bounds.y + bounds.height) - 1, 0, TRAY_TEMPLATE_WORK_SIZE - 1);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let covered = 0;
      for (const sampleY of samples) {
        for (const sampleX of samples) {
          if (predicate(x + sampleX, y + sampleY)) covered += 1;
        }
      }
      if (covered === 0) continue;
      const offset = (y * TRAY_TEMPLATE_WORK_SIZE + x) * 4;
      const sourceAlpha = boundedAlpha * covered / (samples.length * samples.length);
      const destinationAlpha = bitmap[offset + 3] / 255;
      bitmap[offset] = 255;
      bitmap[offset + 1] = 255;
      bitmap[offset + 2] = 255;
      bitmap[offset + 3] = Math.round((sourceAlpha + destinationAlpha * (1 - sourceAlpha)) * 255);
    }
  }
}

function paintRoundedRect(bitmap, rect, radius, alpha) {
  paintShape(
    bitmap,
    rect,
    (x, y) => insideRoundedRect(x, y, rect, radius),
    alpha,
  );
}

function paintRoundedOutline(bitmap, rect, lineWidth, alpha) {
  const inner = {
    x: rect.x + lineWidth,
    y: rect.y + lineWidth,
    width: rect.width - lineWidth * 2,
    height: rect.height - lineWidth * 2,
  };
  const radius = rect.height / 2;
  paintShape(
    bitmap,
    rect,
    (x, y) => insideRoundedRect(x, y, rect, radius)
      && (inner.width <= 0
        || inner.height <= 0
        || !insideRoundedRect(x, y, inner, Math.max(0, radius - lineWidth))),
    alpha,
  );
}

function paintCircle(bitmap, centerX, centerY, radius, alpha) {
  paintShape(
    bitmap,
    {
      x: centerX - radius,
      y: centerY - radius,
      width: radius * 2,
      height: radius * 2,
    },
    (x, y) => {
      const deltaX = x - centerX;
      const deltaY = y - centerY;
      return deltaX * deltaX + deltaY * deltaY <= radius * radius;
    },
    alpha,
  );
}

function trayGlyphDescriptor(trayStatus) {
  if (trayStatus === undefined) return { kind: "unavailable", birdAlpha: 0.42 };
  let status;
  try {
    status = validateDesktopTrayStatus(trayStatus);
  } catch {
    return { kind: "unavailable", birdAlpha: 0.42 };
  }
  if (status.status === "analyzing") return { kind: "analyzing", birdAlpha: 1 };
  if (status.status === "stale") return { kind: "stale", birdAlpha: 0.58 };
  if (status.status === "fresh" && status.allowance !== null) {
    return {
      kind: "live",
      birdAlpha: 1,
      remainingPercent: status.allowance.remainingPercent,
    };
  }
  return { kind: "unavailable", birdAlpha: 0.42 };
}

function trayGlyphKey(descriptor) {
  return descriptor.kind === "live"
    ? `live:${Object.is(descriptor.remainingPercent, -0) ? 0 : descriptor.remainingPercent}`
    : descriptor.kind;
}

function drawNativeTrayMeter(bitmap, descriptor) {
  const rect = scaledNativeRect(NATIVE_TRAY_METER_RECT);
  const radius = rect.height / 2;
  if (descriptor.kind === "live") {
    paintRoundedRect(bitmap, rect, radius, 0.24);
    if (descriptor.remainingPercent <= 0) return;
    paintRoundedRect(bitmap, {
      ...rect,
      width: Math.min(
        rect.width,
        Math.max(0.8 * TRAY_TEMPLATE_DRAW_SCALE, rect.width * descriptor.remainingPercent / 100),
      ),
    }, radius, 1);
    return;
  }
  if (descriptor.kind === "analyzing") {
    paintRoundedRect(bitmap, rect, radius, 0.3);
    for (const fraction of [0.25, 0.5, 0.75]) {
      paintCircle(
        bitmap,
        rect.x + rect.width * fraction,
        rect.y + rect.height / 2,
        0.6 * TRAY_TEMPLATE_DRAW_SCALE,
        1,
      );
    }
    return;
  }
  paintRoundedOutline(
    bitmap,
    rect,
    0.8 * TRAY_TEMPLATE_DRAW_SCALE,
    descriptor.kind === "stale" ? 0.55 : 0.42,
  );
}

function composeNativeTrayGlyph(baseSource, descriptor) {
  if (baseSource === null
      || typeof baseSource !== "object"
      || typeof baseSource.resize !== "function") return null;
  const birdRect = scaledNativeRect(NATIVE_TRAY_BIRD_RECT);
  let bird;
  try {
    bird = baseSource.resize({
      width: Math.round(birdRect.width),
      height: Math.round(birdRect.height),
      quality: "best",
    });
    if (!isNonEmptyNativeImage(bird) || typeof bird.toBitmap !== "function") return null;
  } catch {
    return null;
  }
  let birdBitmap;
  try {
    birdBitmap = Buffer.from(bird.toBitmap());
  } catch {
    return null;
  }
  const birdWidth = Math.round(birdRect.width);
  const birdHeight = Math.round(birdRect.height);
  if (birdBitmap.byteLength !== birdWidth * birdHeight * 4) return null;

  const output = Buffer.alloc(TRAY_TEMPLATE_WORK_SIZE * TRAY_TEMPLATE_WORK_SIZE * 4);
  const left = Math.round(birdRect.x);
  const top = Math.round(birdRect.y);
  for (let y = 0; y < birdHeight; y += 1) {
    for (let x = 0; x < birdWidth; x += 1) {
      const sourceOffset = (y * birdWidth + x) * 4;
      const targetOffset = ((top + y) * TRAY_TEMPLATE_WORK_SIZE + left + x) * 4;
      output[targetOffset] = 255;
      output[targetOffset + 1] = 255;
      output[targetOffset + 2] = 255;
      output[targetOffset + 3] = Math.round(birdBitmap[sourceOffset + 3] * descriptor.birdAlpha);
    }
  }
  drawNativeTrayMeter(output, descriptor);
  return output;
}

function dynamicTemplateImage(nativeImage, baseSource, descriptor) {
  const bitmap = composeNativeTrayGlyph(baseSource, descriptor);
  if (bitmap === null) return null;
  const source = templateSourceFromBitmap(nativeImage, bitmap);
  if (source === null) return null;
  return markTemplateImage(finalizeTemplateSource(nativeImage, source));
}

function desktopTrayAsset({ nativeImage, resourceRoot, platform, icon }) {
  if (icon !== undefined) return { baseSource: null, fallback: icon };
  if (typeof nativeImage?.createFromPath !== "function") return { baseSource: null, fallback: undefined };
  if (typeof resourceRoot !== "string" || !isAbsolute(resourceRoot)) {
    return { baseSource: null, fallback: undefined };
  }

  const iconPath = join(resourceRoot, TRAY_ICON_RELATIVE_PATH);
  let source;
  try {
    source = nativeImage.createFromPath(iconPath);
  } catch {
    return { baseSource: null, fallback: undefined };
  }
  if (!isNonEmptyNativeImage(source) || typeof source.resize !== "function") {
    return { baseSource: null, fallback: undefined };
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
    return { baseSource: null, fallback: undefined };
  }
  if (!isNonEmptyNativeImage(resized)) return { baseSource: null, fallback: undefined };
  if (platform !== "darwin") return { baseSource: null, fallback: resized };

  let baseSource = null;
  if (typeof resized.toBitmap === "function") {
    try {
      const extracted = extractDesktopTrayTemplateBitmap(Buffer.from(resized.toBitmap()));
      if (extracted !== undefined) baseSource = templateSourceFromBitmap(nativeImage, extracted);
    } catch {
      baseSource = null;
    }
  }
  return { baseSource, fallback: resized };
}

/**
 * Create a bounded dynamic macOS tray-image resolver.
 *
 * It loads and extracts the trusted brand asset once. Each status change may
 * compose a new 16pt template glyph, but the last semantic state and image
 * are retained so the five-second status poll neither reloads nor rescales
 * the source asset when nothing visual changed.
 */
export function createDesktopTrayIconFactory(options = {}) {
  const {
    nativeImage,
    resourceRoot,
    platform = process.platform,
    icon,
  } = options;
  const asset = desktopTrayAsset({ nativeImage, resourceRoot, platform, icon });
  let lastKey = null;
  let lastIcon;
  let fallbackResolved = false;
  let fallback;

  function resolveFallback() {
    if (!fallbackResolved) {
      fallbackResolved = true;
      if (platform !== "darwin") {
        fallback = asset.fallback;
      } else {
        fallback = asset.baseSource === null
          ? markTemplateImage(asset.fallback)
          : markTemplateImage(finalizeTemplateSource(nativeImage, asset.baseSource))
            ?? markTemplateImage(asset.fallback);
      }
    }
    return fallback;
  }

  function resolve(trayStatus) {
    if (platform !== "darwin" || asset.baseSource === null) return resolveFallback();
    const descriptor = trayGlyphDescriptor(trayStatus);
    const key = trayGlyphKey(descriptor);
    if (key === lastKey) return lastIcon;
    const next = dynamicTemplateImage(nativeImage, asset.baseSource, descriptor)
      ?? resolveFallback();
    lastKey = key;
    lastIcon = next;
    return next;
  }

  return Object.freeze({ resolve });
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
  trayStatus,
} = {}) {
  return createDesktopTrayIconFactory({
    nativeImage,
    resourceRoot,
    platform,
    icon,
  }).resolve(trayStatus);
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
