/**
 * Positive source membership for the reviewed client surfaces.
 *
 * This is deliberately data-only.  A surface entry is an exact repository
 * relative path, never a glob or a directory to discover.  Route aliases,
 * native policy, public-site exclusions, and test-lane selection remain
 * separate contracts at their owning boundaries.
 */

export const SURFACE_MANIFEST_SCHEMA = "tibotattle-surface-manifest-v0.1";

const SHARED_WEB_FILES = Object.freeze([
  "apps/web/public/app.js",
  "apps/web/public/allowance-tanks.js",
  "apps/web/public/allowance-tank-renderer.js",
  "apps/web/public/community-data.js",
  "apps/web/public/data-client.js",
  "apps/web/public/dashboard-report-preload.js",
  "apps/web/public/dashboard-ui.js",
  "apps/web/public/desktop-shell.js",
  "apps/web/public/electron-settings.css",
  "apps/web/public/electron-settings.html",
  "apps/web/public/electron-settings.js",
  "apps/web/public/electron-tray-popup.css",
  "apps/web/public/electron-tray-popup.html",
  "apps/web/public/electron-tray-popup.js",
  "apps/web/public/electron-tray-preferences.js",
  "apps/web/public/electron-tray-settings.js",
  "apps/web/public/i18n.generated.js",
  "apps/web/public/icon-panel-left.svg",
  "apps/web/public/icon-refresh-cw.svg",
  "apps/web/public/icon-settings.svg",
  "apps/web/public/codex-color.svg",
  "apps/web/public/index.html",
  "apps/web/public/install-cta.js",
  "apps/web/public/lib.js",
  "apps/web/public/localization.js",
  "apps/web/public/model-catalog.generated.js",
  "apps/web/public/model-performance.css",
  "apps/web/public/model-performance.js",
  "apps/web/public/model-visuals.js",
  "apps/web/public/navigation.js",
  "apps/web/public/reporting-period.js",
  "apps/web/public/styles.css",
  "apps/web/public/telemetry-envelope.js",
  "apps/web/public/telemetry-shared.generated.js",
  "apps/web/public/tibotattle-icon.png",
  "apps/web/public/ui-format.js",
  "apps/web/public/work-usage-view.js",
]);

const HISTORY_FREE_EXPORT_ONLY_WEB_FILES = Object.freeze([
  "apps/web/public/community-refresh.js",
  "apps/web/public/community-view.js",
  "apps/web/public/community.html",
  "apps/web/public/community.js",
]);

// The export intentionally omits the dashboard icon: the icon is authenticated
// native/Electron app branding, not part of the history-free source export.
const HISTORY_FREE_EXPORT_WEB_FILES = Object.freeze([
  ...SHARED_WEB_FILES.filter((path) =>
    path !== "apps/web/public/tibotattle-icon.png"),
  ...HISTORY_FREE_EXPORT_ONLY_WEB_FILES,
]);

// The reset helper is a native-only static input.  The web membership is the
// same reviewed local/Electron set, while the Electron shell's own modules and
// native Swift resources remain separate policy inventories.
const NATIVE_MACOS_FILES = Object.freeze([
  ...SHARED_WEB_FILES,
  "apps/macos/reset-local-keychain.js",
]);

export const SURFACE_MANIFEST = Object.freeze({
  schemaVersion: SURFACE_MANIFEST_SCHEMA,
  surfaces: Object.freeze({
    "local-companion": SHARED_WEB_FILES,
    "electron-runtime": SHARED_WEB_FILES,
    "native-macos": NATIVE_MACOS_FILES,
    "history-free-export": HISTORY_FREE_EXPORT_WEB_FILES,
  }),
});
