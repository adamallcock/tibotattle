/**
 * Dependency-injected application-menu descriptors for the Electron shell.
 *
 * The renderer remains a loopback-only dashboard and never receives arbitrary
 * menu commands.  Callers provide bounded main-process actions here; missing
 * actions intentionally become no-ops so a shell can expose the menu before
 * a settings/about controller has been wired in.
 */

import {
  desktopText,
  resolveDesktopLocale,
} from "./desktop-copy.js";

const DESKTOP_ACTION_NAMES = Object.freeze([
  "show",
  "focus",
  "refresh",
  "retry",
  "settings",
  "about",
  "quit",
]);
const ACTION_INTERFACES = new WeakSet();

function noOp() {}

function assertAppName(appName) {
  if (typeof appName !== "string" || appName.trim().length === 0) {
    throw new TypeError("appName is required");
  }
}

function defaultSystemLocales() {
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return ["en-US"];
  }
}

/**
 * Return one stable action object for both application-menu and tray
 * descriptors.  This keeps the two desktop surfaces from growing separate
 * command paths as settings and dashboard controllers are added.
 */
export function createDesktopActionInterface(actions = {}) {
  if (actions === null || typeof actions !== "object" || Array.isArray(actions)) {
    throw new TypeError("actions must be an object");
  }
  if (ACTION_INTERFACES.has(actions)) return actions;
  const boundedActions = Object.freeze(Object.fromEntries(
    DESKTOP_ACTION_NAMES.map((name) => [
      name,
      typeof actions[name] === "function" ? actions[name] : noOp,
    ]),
  ));
  ACTION_INTERFACES.add(boundedActions);
  return boundedActions;
}

function actionItem(label, action, options = {}) {
  return {
    ...options,
    label,
    click: action,
  };
}

/**
 * Build the cross-platform application menu.  Electron expands
 * CmdOrCtrl accelerators to Command on macOS and Control elsewhere.
 */
export function createDesktopMenuTemplate({
  appName = "TiboTattle",
  platform = process.platform,
  actions = createDesktopActionInterface(),
  locale = "system",
  systemLocales = defaultSystemLocales(),
} = {}) {
  assertAppName(appName);
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    throw new TypeError("platform is unsupported");
  }
  const boundedActions = createDesktopActionInterface(actions);
  const textOptions = { locale, systemLocales };
  const platformMenu = platform === "darwin"
    ? {
      label: appName,
      submenu: [
        actionItem(desktopText("electron.menu.about", { appName }, textOptions), boundedActions.about),
        { type: "separator" },
        actionItem(desktopText("electron.menu.settings", {}, textOptions), boundedActions.settings, {
          accelerator: "CmdOrCtrl+,",
        }),
        { type: "separator" },
        actionItem(desktopText("electron.menu.quit", { appName }, textOptions), boundedActions.quit, {
          accelerator: "CmdOrCtrl+Q",
        }),
      ],
    }
    : {
      label: desktopText("electron.menu.file", {}, textOptions),
      submenu: [
        actionItem(desktopText("electron.menu.open", {}, textOptions), boundedActions.show),
        actionItem(desktopText("electron.menu.settings", {}, textOptions), boundedActions.settings, {
          accelerator: "CmdOrCtrl+,",
        }),
        { type: "separator" },
        actionItem(desktopText("electron.menu.exit", {}, textOptions), boundedActions.quit, {
          accelerator: "CmdOrCtrl+Q",
        }),
      ],
    };
  const commonMenus = [
    platformMenu,
    {
      label: desktopText("electron.menu.edit", {}, textOptions),
      submenu: [
        { role: "copy" },
        { role: "selectAll" },
      ],
    },
    {
      label: desktopText("electron.menu.view", {}, textOptions),
      submenu: [
        actionItem(desktopText("electron.menu.refresh", {}, textOptions), boundedActions.refresh, {
          accelerator: "CmdOrCtrl+R",
        }),
        { type: "separator" },
        actionItem(desktopText("electron.menu.show", { appName }, textOptions), boundedActions.show),
        actionItem(desktopText("electron.menu.focus", { appName }, textOptions), boundedActions.focus),
      ],
    },
    {
      label: desktopText("electron.menu.window", {}, textOptions),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "front" },
      ],
    },
  ];
  if (platform !== "darwin") {
    commonMenus.push({
      label: desktopText("electron.menu.help", {}, textOptions),
      submenu: [
        actionItem(desktopText("electron.menu.about", { appName }, textOptions), boundedActions.about),
      ],
    });
  }
  return commonMenus;
}

/**
 * Install a template through the injected Electron Menu module.  Returning
 * null when the runtime does not expose Menu keeps composition tests plain
 * Node while the real shell still fails closed at its existing boundaries.
 */
export function installDesktopApplicationMenu({
  Menu,
  appName = "TiboTattle",
  platform = process.platform,
  actions,
  locale = "system",
  systemLocales = defaultSystemLocales(),
} = {}) {
  if (Menu === null
      || (typeof Menu !== "object" && typeof Menu !== "function")) return null;
  if (typeof Menu.buildFromTemplate !== "function") return null;
  const menu = Menu.buildFromTemplate(createDesktopMenuTemplate({
    appName,
    platform,
    actions,
    locale,
    systemLocales,
  }));
  Menu.setApplicationMenu?.(menu);
  return menu;
}

export { DESKTOP_ACTION_NAMES, desktopText, resolveDesktopLocale };
