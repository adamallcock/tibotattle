import { win32 } from "node:path";

import distribution from "../../config/electron-production-distribution.cjs";

const WINDOWS_NOTIFICATION_SHORTCUT_LEAF = "TiboTattle.lnk";
const WINDOWS_NOTIFICATION_START_MENU_SEGMENTS = Object.freeze([
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  WINDOWS_NOTIFICATION_SHORTCUT_LEAF,
]);

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function configuredIdentity(identity) {
  if (!isPlainRecord(identity)
      || Reflect.ownKeys(identity).length !== 2
      || typeof identity.appUserModelId !== "string"
      || identity.appUserModelId.length === 0
      || typeof identity.toastActivatorClsid !== "string"
      || !/^\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/iu.test(
        identity.toastActivatorClsid,
      )) {
    return null;
  }
  return identity;
}

function productionIdentity() {
  return configuredIdentity({
    appUserModelId: distribution.PRODUCTION_ELECTRON_APP_ID,
    toastActivatorClsid: distribution.PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID,
  });
}

function normalizedWindowsPath(value, pathApi) {
  if (typeof value !== "string" || value.length === 0 || !pathApi.isAbsolute(value)) {
    return null;
  }
  return pathApi.normalize(value).toLowerCase();
}

/**
 * Configure Windows toast delivery only after verifying the real installed
 * Start Menu entry. This proves the in-process AppUserModelID is bound to the
 * executable the installer registered; it does not replace signed-installer
 * verification, which remains a release qualification responsibility.
 *
 * Electron 43 owns the toast registration. Its fixed CLSID is set only after
 * the Start Menu target and AppUserModelID are verified, rather than creating
 * or repairing a shortcut at application startup.
 */
export function prepareWindowsNotificationIdentity({
  app,
  shell,
  platform = process.platform,
  identity = productionIdentity(),
  pathApi = win32,
} = {}) {
  try {
    if (platform !== "win32" || app?.isPackaged !== true
        || typeof app.getName !== "function" || app.getName() !== "TiboTattle"
        || typeof app.getPath !== "function"
        || typeof app.setAppUserModelId !== "function"
        || typeof app.setToastActivatorCLSID !== "function"
        || typeof shell?.readShortcutLink !== "function") {
      return false;
    }
  } catch {
    return false;
  }
  const selectedIdentity = configuredIdentity(identity);
  if (selectedIdentity === null) return false;

  let shortcut;
  let expectedTarget;
  try {
    const appData = app.getPath("appData");
    const target = app.getPath("exe");
    if (normalizedWindowsPath(appData, pathApi) === null) return false;
    expectedTarget = normalizedWindowsPath(target, pathApi);
    if (expectedTarget === null) return false;
    shortcut = shell.readShortcutLink(pathApi.join(
      appData,
      ...WINDOWS_NOTIFICATION_START_MENU_SEGMENTS,
    ));
  } catch {
    return false;
  }
  if (!isPlainRecord(shortcut)
      || normalizedWindowsPath(shortcut.target, pathApi) !== expectedTarget
      || shortcut.appUserModelId !== selectedIdentity.appUserModelId) {
    return false;
  }

  try {
    app.setAppUserModelId(selectedIdentity.appUserModelId);
    app.setToastActivatorCLSID(selectedIdentity.toastActivatorClsid);
  } catch {
    return false;
  }
  return true;
}
