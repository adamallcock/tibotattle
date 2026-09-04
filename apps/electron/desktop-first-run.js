import {
  createPosixDesktopSettingsBackend,
  createWindowsDesktopSettingsBackend,
  DesktopSettingsBackendError,
  DESKTOP_SETTINGS_BACKEND_MAX_BYTES,
} from "./desktop-settings-backends.js";
import { desktopText } from "./desktop-copy.js";

/**
 * The acknowledgement is a separate fixed protected record.  It must not be
 * folded into renderer storage or the ordinary settings snapshot: an
 * acknowledgement is a launch gate, not a user preference.
 */
export const DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION =
  "tibotattle-desktop-first-run-v1";
export const DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME =
  "desktop-first-run-v1.json";

export const DESKTOP_FIRST_RUN_CONTINUE_LABEL = "Continue";
export const DESKTOP_FIRST_RUN_QUIT_LABEL = "Quit";

const RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "acknowledged",
]);

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, keys, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has unexpected keys`);
  }
  return value;
}

/** Validate and clone the only receipt that can authorize a launch. */
export function validateDesktopFirstRunReceipt(receipt) {
  assertExactKeys(receipt, RECEIPT_KEYS, "receipt");
  if (receipt.schemaVersion !== DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION) {
    throw new TypeError("receipt schemaVersion is invalid");
  }
  if (receipt.acknowledged !== true) {
    throw new TypeError("receipt acknowledged is invalid");
  }
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    acknowledged: true,
  });
}

const ACKNOWLEDGED_RECEIPT = validateDesktopFirstRunReceipt({
  schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  acknowledged: true,
});

function receiptCodec() {
  return Object.freeze({
    encode(value, maximumBytes) {
      const validated = validateDesktopFirstRunReceipt(value);
      let bytes;
      try {
        bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
      } catch {
        throw new DesktopSettingsBackendError("invalid_snapshot");
      }
      if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
        bytes.fill(0);
        throw new DesktopSettingsBackendError("too_large");
      }
      return Object.freeze({ value: validated, bytes });
    },
    decodeBytes(bytes) {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        throw new DesktopSettingsBackendError("corrupt");
      }
      try {
        return validateDesktopFirstRunReceipt(parsed);
      } catch {
        throw new DesktopSettingsBackendError("corrupt");
      }
    },
    decodeValue(value) {
      try {
        return validateDesktopFirstRunReceipt(value);
      } catch {
        throw new DesktopSettingsBackendError("corrupt");
      }
    },
  });
}

const RECEIPT_CODEC = receiptCodec();

function assertOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  return options;
}

/**
 * Create the protected sibling record used by the first-run gate.
 *
 * POSIX hosts use the same owner-only atomic backend as desktop settings. The
 * Windows path accepts only the repository-branded protected state store and
 * therefore has no Node filesystem fallback.
 */
export function createDesktopFirstRunReceiptBackend(options = {}) {
  const configuration = assertOptions(options);
  const platform = configuration.platform ?? process.platform;
  const maximumBytes = configuration.maximumBytes
    ?? DESKTOP_SETTINGS_BACKEND_MAX_BYTES;
  if (platform === "win32") {
    return createWindowsDesktopSettingsBackend({
      ...configuration,
      platform,
      childName: DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME,
      maximumBytes,
      codec: RECEIPT_CODEC,
    });
  }
  return createPosixDesktopSettingsBackend({
    ...configuration,
    platform,
    filename: DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME,
    maximumBytes,
    codec: RECEIPT_CODEC,
  });
}

function assertDialog(dialog) {
  if (dialog === null
      || typeof dialog !== "object"
      || typeof dialog.showMessageBox !== "function") {
    throw new TypeError("dialog.showMessageBox is required");
  }
  return dialog;
}

function assertReceiptBackend(backend) {
  if (backend === null
      || typeof backend !== "object"
      || typeof backend.load !== "function"
      || typeof backend.save !== "function") {
    throw new TypeError("receiptBackend must implement load and save");
  }
  return backend;
}

async function quitCleanly(quit) {
  try {
    await quit();
  } catch {
    // A failed quit request must not proceed to a companion launch.
  }
}

function firstRunTextOptions({ locale = "system", systemLocales = [] } = {}) {
  return { locale, systemLocales };
}

export function desktopFirstRunDialogCopy(options = {}) {
  const textOptions = firstRunTextOptions(options);
  return Object.freeze({
    title: desktopText("electron.firstRun.title", {}, textOptions),
    message: desktopText("electron.firstRun.message", {}, textOptions),
    detail: desktopText("electron.firstRun.detail", {}, textOptions),
    checkboxLabel: desktopText(
      "electron.firstRun.checkbox.startAtLogin",
      {},
      textOptions,
    ),
    failureTitle: desktopText("electron.firstRun.failure.title", {}, textOptions),
    failureMessage: desktopText("electron.firstRun.failure.message", {}, textOptions),
    failureDetail: desktopText("electron.firstRun.failure.detail", {}, textOptions),
    buttons: Object.freeze([
      desktopText("electron.firstRun.continue", {}, textOptions),
      desktopText("electron.firstRun.quit", {}, textOptions),
    ]),
  });
}

async function showFailure(dialog, copy) {
  try {
    await dialog.showMessageBox({
      type: "error",
      title: copy.failureTitle,
      message: copy.failureMessage,
      detail: copy.failureDetail,
      buttons: [copy.buttons[1]],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } catch {
    // The app quit below remains the fail-closed behavior if Electron cannot
    // display the native error dialog.
  }
}

/**
 * Gate the first companion launch on an explicit native acknowledgement.
 * Missing is the only state that may show the consent dialog.  Any existing
 * but invalid/unsafe receipt is a visible fail-closed error.
 */
export async function ensureDesktopFirstRunAcknowledged({
  dialog,
  receiptBackend,
  quit = () => {},
  locale = "system",
  systemLocales = [],
} = {}) {
  const nativeDialog = assertDialog(dialog);
  const backend = assertReceiptBackend(receiptBackend);
  const copy = desktopFirstRunDialogCopy({ locale, systemLocales });

  let receipt;
  try {
    receipt = await backend.load();
  } catch {
    await showFailure(nativeDialog, copy);
    await quitCleanly(quit);
    return Object.freeze({
      status: "blocked",
      reason: "invalid_receipt",
      startAtLogin: false,
    });
  }
  if (receipt !== null && receipt !== undefined) {
    try {
      validateDesktopFirstRunReceipt(receipt);
    } catch {
      await showFailure(nativeDialog, copy);
      await quitCleanly(quit);
      return Object.freeze({
        status: "blocked",
        reason: "invalid_receipt",
        startAtLogin: false,
      });
    }
    // A receipt only acknowledges the privacy disclosure. It deliberately
    // carries no login-item preference: upgrades and repeat launches must
    // never silently opt an existing user into start-at-login.
    return Object.freeze({ status: "acknowledged", receipt, startAtLogin: false });
  }

  let response;
  try {
    response = await nativeDialog.showMessageBox({
      type: "info",
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [...copy.buttons],
      checkboxLabel: copy.checkboxLabel,
      checkboxChecked: true,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
  } catch {
    await quitCleanly(quit);
    return Object.freeze({
      status: "blocked",
      reason: "dialog_unavailable",
      startAtLogin: false,
    });
  }
  if (response?.response !== 0) {
    await quitCleanly(quit);
    return Object.freeze({ status: "cancelled", startAtLogin: false });
  }

  try {
    await backend.save(ACKNOWLEDGED_RECEIPT);
  } catch {
    await showFailure(nativeDialog, copy);
    await quitCleanly(quit);
    return Object.freeze({
      status: "blocked",
      reason: "persistence_failed",
      startAtLogin: false,
    });
  }
  return Object.freeze({
    status: "acknowledged",
    receipt: ACKNOWLEDGED_RECEIPT,
    // Electron's checkbox result is intentionally ephemeral. The parent
    // runtime may consume this one bounded true/false value to register the
    // platform login item, but it must not be persisted in the receipt.
    startAtLogin: response?.checkboxChecked === true,
  });
}

export const DESKTOP_FIRST_RUN_DIALOG_COPY = desktopFirstRunDialogCopy();
