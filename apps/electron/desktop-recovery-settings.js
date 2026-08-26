import { desktopText } from "./desktop-copy.js";

/**
 * The recovery window has no companion origin, so its Settings action cannot
 * open the ordinary renderer surface.  This module deliberately keeps the
 * repair ceremony in the main process: the only input is a fixed native
 * dialog response, and the only effects are the two controller handlers.
 */

export const DESKTOP_RECOVERY_SETTINGS_STATUSES = Object.freeze([
  "cancelled",
  "choose_applied",
  "default_applied",
  "dialog_unavailable",
  "action_failed",
]);

const OPTION_KEYS = Object.freeze([
  "controller",
  "dialog",
  "locale",
  "systemLocales",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixedResult(status) {
  if (!DESKTOP_RECOVERY_SETTINGS_STATUSES.includes(status)) {
    throw new TypeError("recovery Settings status is invalid");
  }
  return Object.freeze({ status });
}

function assertDialog(dialog) {
  if (!isRecord(dialog) || typeof dialog.showMessageBox !== "function") {
    throw new TypeError("dialog.showMessageBox is required");
  }
  return dialog;
}

function assertController(controller) {
  if (!isRecord(controller) || !isRecord(controller.handlers)) {
    throw new TypeError("controller.handlers is required");
  }
  if (typeof controller.handlers.chooseCodexHome !== "function") {
    throw new TypeError("controller.handlers.chooseCodexHome is required");
  }
  if (typeof controller.handlers.useDefaultCodexHome !== "function") {
    throw new TypeError("controller.handlers.useDefaultCodexHome is required");
  }
  if (controller.replaceCodexHome !== undefined
      && typeof controller.replaceCodexHome !== "function") {
    throw new TypeError("controller.replaceCodexHome must be a function");
  }
  return controller;
}

function assertLocaleOptions(options) {
  const locale = options.locale ?? "system";
  const systemLocales = options.systemLocales ?? [];
  if (typeof locale !== "string" || locale.length === 0 || locale.length > 80) {
    throw new TypeError("locale must be a bounded string");
  }
  if (!Array.isArray(systemLocales)
      || systemLocales.length > 16
      || systemLocales.some((value) => (
        typeof value !== "string" || value.length === 0 || value.length > 80
      ))) {
    throw new TypeError("systemLocales must be bounded strings");
  }
  return Object.freeze({
    locale,
    systemLocales: Object.freeze([...systemLocales]),
  });
}

function assertOptions(options) {
  if (!isRecord(options)) throw new TypeError("options must be an object");
  const unexpected = Reflect.ownKeys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unexpected.length > 0) throw new TypeError("options has unexpected keys");
  const localeOptions = assertLocaleOptions(options);
  return Object.freeze({
    controller: assertController(options.controller),
    dialog: assertDialog(options.dialog),
    ...localeOptions,
  });
}

function fixedCopyText(key, textOptions) {
  const value = desktopText(key, {}, textOptions);
  if (typeof value !== "string" || value.length === 0 || value === key) {
    throw new TypeError("recovery Settings copy is unavailable");
  }
  return value;
}

/** Return the fixed, renderer-independent native recovery dialog copy. */
export function desktopRecoverySettingsDialogCopy({
  locale = "system",
  systemLocales = [],
} = {}) {
  const textOptions = { locale, systemLocales };
  return Object.freeze({
    title: fixedCopyText("electron.recovery.settings.title", textOptions),
    message: fixedCopyText("electron.recovery.settings.message", textOptions),
    detail: fixedCopyText("electron.recovery.settings.detail", textOptions),
    buttons: Object.freeze([
      fixedCopyText("electron.recovery.settings.choose", textOptions),
      fixedCopyText("electron.recovery.settings.useDefault", textOptions),
      fixedCopyText("electron.recovery.settings.cancel", textOptions),
    ]),
    failureTitle: fixedCopyText("electron.recovery.settings.failureTitle", textOptions),
    failureMessage: fixedCopyText("electron.recovery.settings.failureMessage", textOptions),
    failureDetail: fixedCopyText("electron.recovery.settings.failureDetail", textOptions),
  });
}

async function showFixedFailure(dialog, copy) {
  try {
    await dialog.showMessageBox({
      type: "error",
      title: copy.failureTitle,
      message: copy.failureMessage,
      detail: copy.failureDetail,
      buttons: [copy.buttons[2]],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } catch {
    // Recovery Retry and Quit are owned by the lifecycle. A native dialog
    // failure must never escape this action or disable those controls.
  }
}

async function showOnce({ controller, dialog }, copy) {
  let response;
  try {
    response = await dialog.showMessageBox({
      type: "warning",
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [...copy.buttons],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
  } catch {
    return fixedResult("dialog_unavailable");
  }

  const selected = response?.response;
  if (selected !== 0 && selected !== 1) return fixedResult("cancelled");

  try {
    // Keep the argument shape explicit. The handlers are main-process
    // capability ports and accept no path or renderer-supplied data here.
    if (selected === 0) {
      if (typeof controller.replaceCodexHome === "function") {
        await controller.replaceCodexHome();
      } else {
        await controller.handlers.chooseCodexHome({});
      }
    } else {
      await controller.handlers.useDefaultCodexHome({});
    }
    return fixedResult(selected === 0 ? "choose_applied" : "default_applied");
  } catch {
    await showFixedFailure(dialog, copy);
    return fixedResult("action_failed");
  }
}

/**
 * Construct a serialized recovery Settings action. Concurrent invocations
 * share one native dialog/action promise; after it settles, a later recovery
 * click may begin a fresh bounded attempt.
 */
export function createDesktopRecoverySettingsAction(options = {}) {
  const configuration = assertOptions(options);
  const copy = desktopRecoverySettingsDialogCopy(configuration);
  let active = null;

  function show() {
    if (active !== null) return active;
    const current = Promise.resolve()
      .then(() => showOnce(configuration, copy))
      .catch(() => fixedResult("dialog_unavailable"));
    const shared = current.finally(() => {
      if (active === shared) active = null;
    });
    active = shared;
    return shared;
  }

  return Object.freeze({ show });
}

export const DESKTOP_RECOVERY_SETTINGS_DIALOG_COPY =
  desktopRecoverySettingsDialogCopy();
