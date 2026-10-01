const ELECTRON_API_VERSION = "v1";
const DESKTOP_APPEARANCE_PREFERENCES = new Set(["system", "light", "dark"]);

export function isElectronDashboard(documentRef, windowRef) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version === ELECTRON_API_VERSION) return true;
  return documentRef?.documentElement?.classList?.contains("electron-dashboard") === true
    || documentRef?.body?.classList?.contains("electron-dashboard") === true;
}

export function resolveDesktopAppearance(
  preference,
  { windowRef = globalThis.window } = {},
) {
  if (!DESKTOP_APPEARANCE_PREFERENCES.has(preference)) return null;
  if (preference === "light" || preference === "dark") return preference;
  try {
    return windowRef?.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function resolveElectronStartupAppearance({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (!isElectronDashboard(documentRef, windowRef)) return null;
  // The main process applies the persisted Electron nativeTheme.themeSource
  // before it creates the BrowserWindow. Chromium's media query is therefore
  // the synchronous resolved value for system, forced-light, and forced-dark
  // preferences, without waiting for an IPC round trip after first paint.
  return resolveDesktopAppearance("system", { windowRef });
}
