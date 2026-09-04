import { desktopText } from "./desktop-copy.js";

/**
 * The first-run login-item choice is deliberately a one-shot capability. It
 * is not a preference migration and it is not read from the persisted
 * acknowledgement receipt. Only the fresh, affirmative result from the
 * first-run dialog can reach the platform login-item handler.
 */
export const DESKTOP_FIRST_RUN_LOGIN_STATUSES = Object.freeze([
  "not_requested",
  "enabled",
  "needs_approval",
  "continued_without_login",
]);

const FIRST_RUN_STATUSES = new Set(["acknowledged", "cancelled", "blocked"]);
const LOGIN_ITEM_STATUSES = new Set([
  "enabled",
  "needs-approval",
  "disabled",
  "unavailable",
  "error",
]);

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function fixedResult(status) {
  if (!DESKTOP_FIRST_RUN_LOGIN_STATUSES.includes(status)) {
    throw new TypeError("first-run login result status is invalid");
  }
  return Object.freeze({ status });
}

function assertLocaleOptions({ locale = "system", systemLocales = [] } = {}) {
  if (typeof locale !== "string" || locale.length === 0 || locale.length > 80) {
    throw new TypeError("locale must be a bounded string");
  }
  if (!Array.isArray(systemLocales)
      || systemLocales.length > 16
      || systemLocales.some((value) => typeof value !== "string" || value.length > 80)) {
    throw new TypeError("systemLocales must be bounded strings");
  }
  return Object.freeze({ locale, systemLocales: Object.freeze([...systemLocales]) });
}

function assertDialog(dialog) {
  assertPlainRecord(dialog, "dialog");
  if (typeof dialog.showMessageBox !== "function") {
    throw new TypeError("dialog.showMessageBox is required");
  }
  return dialog;
}

function assertController(controller) {
  assertPlainRecord(controller, "controller");
  const handlers = assertPlainRecord(controller.handlers, "controller.handlers");
  if (typeof handlers.setStartAtLogin !== "function") {
    throw new TypeError("controller.handlers.setStartAtLogin is required");
  }
  if (typeof handlers.openSystemSettings !== "function") {
    throw new TypeError("controller.handlers.openSystemSettings is required");
  }
  return controller;
}

/**
 * Validate the bounded result produced by ensureDesktopFirstRunAcknowledged.
 * The receipt and blocked reason are intentionally not inspected by this
 * module: registration is authorized only by `status` plus the ephemeral
 * boolean `startAtLogin`.
 */
function validateFirstRunResult(firstRun) {
  assertPlainRecord(firstRun, "firstRun");
  if (typeof firstRun.status !== "string" || !FIRST_RUN_STATUSES.has(firstRun.status)) {
    throw new TypeError("firstRun.status is invalid");
  }
  if (typeof firstRun.startAtLogin !== "boolean") {
    throw new TypeError("firstRun.startAtLogin is invalid");
  }

  const expected = firstRun.status === "acknowledged"
    ? [["status", "startAtLogin"], ["status", "receipt", "startAtLogin"]]
    : firstRun.status === "blocked"
      ? [["status", "reason", "startAtLogin"]]
      : [["status", "startAtLogin"]];
  const keys = Reflect.ownKeys(firstRun);
  const matches = expected.some((candidate) => keys.length === candidate.length
    && candidate.every((key) => Object.hasOwn(firstRun, key)));
  if (!matches) throw new TypeError("firstRun has unexpected keys");
  if (firstRun.status === "blocked" && typeof firstRun.reason !== "string") {
    throw new TypeError("firstRun.reason is invalid");
  }
  return firstRun;
}

function fixedCopyText(key, textOptions) {
  const value = desktopText(key, {}, textOptions);
  if (typeof value !== "string" || value.length === 0 || value === key) {
    throw new TypeError("first-run login copy is unavailable");
  }
  return value;
}

function desktopFirstRunLoginDialogCopy({ locale = "system", systemLocales = [] } = {}) {
  const textOptions = { locale, systemLocales };
  return Object.freeze({
    title: fixedCopyText("electron.firstRun.loginRegistration.title", textOptions),
    message: fixedCopyText("electron.firstRun.loginRegistration.message", textOptions),
    detail: fixedCopyText("electron.firstRun.loginRegistration.detail", textOptions),
    buttons: Object.freeze([
      fixedCopyText("electron.firstRun.loginRegistration.continue", textOptions),
      fixedCopyText("electron.firstRun.loginRegistration.openSettings", textOptions),
    ]),
  });
}

function readLoginItemStatus(snapshot) {
  // Keep this boundary intentionally narrow. In particular, never inspect or
  // return `detail`, errors, paths, or any renderer/provider data from the
  // controller snapshot.
  if (!isPlainRecord(snapshot)
      || !isPlainRecord(snapshot.settings)
      || !isPlainRecord(snapshot.settings.startAtLogin)) {
    return null;
  }
  const status = snapshot.settings.startAtLogin.status;
  return typeof status === "string" && LOGIN_ITEM_STATUSES.has(status)
    ? status
    : null;
}

async function continueWithoutLogin({
  controller,
  dialog,
  copy,
  status,
}) {
  let response;
  try {
    response = await dialog.showMessageBox({
      type: "warning",
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [...copy.buttons],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } catch {
    return fixedResult(status);
  }

  if (response?.response !== 1) return fixedResult(status);
  try {
    // This is the only system-settings target permitted by this helper. The
    // controller remains the injected main-process boundary for the action.
    await controller.handlers.openSystemSettings({ target: "startup" });
  } catch {
    // Startup must continue even if the OS settings surface cannot be opened.
  }
  return fixedResult(status);
}

async function applyOnce({ firstRun, controller, dialog, copy }) {
  validateFirstRunResult(firstRun);
  if (firstRun.status !== "acknowledged" || firstRun.startAtLogin !== true) {
    return fixedResult("not_requested");
  }

  let snapshot;
  try {
    snapshot = await controller.handlers.setStartAtLogin({ enabled: true });
  } catch {
    return continueWithoutLogin({
      controller,
      dialog,
      copy,
      status: "continued_without_login",
    });
  }

  const status = readLoginItemStatus(snapshot);
  if (status === "enabled") return fixedResult("enabled");
  if (status === "needs-approval") {
    return continueWithoutLogin({
      controller,
      dialog,
      copy,
      status: "needs_approval",
    });
  }
  return continueWithoutLogin({
    controller,
    dialog,
    copy,
    status: "continued_without_login",
  });
}

function assertRegistrarOptions(options) {
  const configuration = assertPlainRecord(options, "options");
  const allowed = new Set(["controller", "dialog", "locale", "systemLocales"]);
  if (Reflect.ownKeys(configuration).some((key) => !allowed.has(key))) {
    throw new TypeError("options has unexpected keys");
  }
  const localeOptions = assertLocaleOptions(configuration);
  return Object.freeze({
    controller: assertController(configuration.controller),
    dialog: assertDialog(configuration.dialog),
    locale: localeOptions.locale,
    systemLocales: localeOptions.systemLocales,
  });
}

/**
 * Create a one-shot first-run login registrar. Repeated calls to `apply`
 * share the same promise/result, so an accidental duplicate integration call
 * cannot register the operating-system login item twice or show two dialogs.
 */
export function createDesktopFirstRunLoginRegistrar(options = {}) {
  const configuration = assertRegistrarOptions(options);
  const copy = desktopFirstRunLoginDialogCopy(configuration);
  let attempt = null;

  async function apply(firstRun) {
    // Validate before caching so a programmer mistake does not permanently
    // poison the registrar and a later valid launch result can still proceed.
    validateFirstRunResult(firstRun);
    if (attempt === null) {
      attempt = applyOnce({ ...configuration, firstRun, copy });
    }
    return attempt;
  }

  return Object.freeze({ apply });
}

/**
 * Convenience one-shot call for runtime composition. Runtime code that may
 * invoke the operation from more than one lifecycle path should retain the
 * registrar returned by createDesktopFirstRunLoginRegistrar instead.
 */
export async function registerDesktopFirstRunLogin({
  firstRun,
  ...options
} = {}) {
  return createDesktopFirstRunLoginRegistrar(options).apply(firstRun);
}

export { desktopFirstRunLoginDialogCopy };
