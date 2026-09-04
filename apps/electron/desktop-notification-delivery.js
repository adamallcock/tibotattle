import {
  DESKTOP_NOTIFICATION_KEYS,
} from "./desktop-notification-policy.js";
import { desktopText } from "./desktop-copy.js";

/**
 * Main-process-only adapter for the semantic result emitted by
 * desktop-notification-policy.js.
 *
 * The policy owns evidence, thresholds, reset precedence, and duplicate
 * suppression. This adapter deliberately accepts only its small frozen
 * semantic notification value. It never accepts a body, title, provider,
 * account, path, identity, or renderer request. The platform capability gate
 * is explicit so a development build cannot claim that it can deliver an
 * alert merely because Electron exposes a Notification constructor.
 */

export const DESKTOP_NOTIFICATION_DELIVERY_STATUSES = Object.freeze([
  "ready",
  "delivered",
  "not_packaged",
  "windows_identity_unavailable",
  "unsupported",
  "capability_error",
  "native_error",
]);

export const DESKTOP_NOTIFICATION_COPY_KEYS = Object.freeze({
  THRESHOLD_80_TITLE: "electron.notification.threshold80.title",
  THRESHOLD_80_BODY: "electron.notification.threshold80.body",
  THRESHOLD_90_TITLE: "electron.notification.threshold90.title",
  THRESHOLD_90_BODY: "electron.notification.threshold90.body",
  RESET_TITLE: "electron.notification.reset.title",
  RESET_BODY: "electron.notification.reset.body",
});

const THRESHOLD_KEYS = new Set([80, 90]);

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function invalidNotification(message = "notification is invalid") {
  return new TypeError(message);
}

/**
 * Validate and clone exactly the semantic notification value produced by the
 * policy. State, outcome, reason, and every other policy field remain outside
 * the delivery boundary; the caller should invoke this only when the policy
 * result has outcome `notification`.
 */
export function validateDesktopNotificationToDeliver(value) {
  if (!isPlainRecord(value)) {
    throw invalidNotification();
  }
  if (value.key === DESKTOP_NOTIFICATION_KEYS.THRESHOLD) {
    if (!hasExactKeys(value, ["key", "thresholdPercent"])) {
      throw invalidNotification("threshold notification has unexpected fields");
    }
    if (!Number.isInteger(value.thresholdPercent)
        || !THRESHOLD_KEYS.has(value.thresholdPercent)) {
      throw invalidNotification("threshold notification percent is invalid");
    }
    return Object.freeze({
      key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
      thresholdPercent: value.thresholdPercent,
    });
  }
  if (value.key === DESKTOP_NOTIFICATION_KEYS.RESET) {
    if (!hasExactKeys(value, ["key"])) {
      throw invalidNotification("reset notification has unexpected fields");
    }
    return Object.freeze({ key: DESKTOP_NOTIFICATION_KEYS.RESET });
  }
  throw invalidNotification("notification key is invalid");
}

function copyForNotification(notification, textOptions) {
  const keys = notification.key === DESKTOP_NOTIFICATION_KEYS.RESET
    ? [DESKTOP_NOTIFICATION_COPY_KEYS.RESET_TITLE, DESKTOP_NOTIFICATION_COPY_KEYS.RESET_BODY]
    : notification.thresholdPercent === 80
      ? [DESKTOP_NOTIFICATION_COPY_KEYS.THRESHOLD_80_TITLE, DESKTOP_NOTIFICATION_COPY_KEYS.THRESHOLD_80_BODY]
      : [DESKTOP_NOTIFICATION_COPY_KEYS.THRESHOLD_90_TITLE, DESKTOP_NOTIFICATION_COPY_KEYS.THRESHOLD_90_BODY];
  const title = desktopText(keys[0], {}, textOptions);
  const body = desktopText(keys[1], {}, textOptions);
  if (typeof title !== "string" || title.length === 0
      || typeof body !== "string" || body.length === 0
      || title === keys[0] || body === keys[1]) {
    throw new TypeError("notification copy is unavailable");
  }
  return Object.freeze({ title, body });
}

function fixedStatus(status) {
  return Object.freeze({ status });
}

function assertOptions(options) {
  if (!isPlainRecord(options)) {
    throw new TypeError("notification delivery options must be a plain object");
  }
  const allowed = new Set([
    "Notification",
    "app",
    "platform",
    "locale",
    "systemLocales",
    "windowsIdentityReady",
  ]);
  if (Reflect.ownKeys(options).some((key) => !allowed.has(key))) {
    throw new TypeError("notification delivery options have unexpected fields");
  }
  return options;
}

function assertPlatform(value) {
  if (!new Set(["darwin", "win32", "linux"]).has(value)) {
    throw new TypeError("notification delivery platform is unsupported");
  }
  return value;
}

function capabilityStatus({ Notification, app, platform, windowsIdentityReady }) {
  // Electron's renderer and development process can expose Notification even
  // though the development artifact has no registered OS notification
  // identity. Keep this gate before probing the native constructor.
  if (app?.isPackaged !== true) return fixedStatus("not_packaged");
  if (platform === "win32" && windowsIdentityReady !== true) {
    // Windows requires the packaged Start Menu shortcut/AppUserModelID and
    // matching ToastActivatorCLSID. The parent runtime must set this flag
    // only after those production identity prerequisites are verified.
    return fixedStatus("windows_identity_unavailable");
  }
  let supported;
  try {
    supported = Notification.isSupported();
  } catch {
    return fixedStatus("capability_error");
  }
  if (supported !== true) return fixedStatus("unsupported");
  return fixedStatus("ready");
}

/**
 * Build a bounded main-process notification port. No Electron module is
 * imported here, which keeps the contract deterministic and makes it
 * impossible for the renderer bridge to acquire a delivery primitive.
 */
export function createDesktopNotificationDelivery(options = {}) {
  const configuration = assertOptions(options);
  const Notification = configuration.Notification;
  const app = configuration.app;
  const platform = assertPlatform(configuration.platform ?? process.platform);
  const locale = configuration.locale ?? "system";
  const systemLocales = configuration.systemLocales ?? [];
  const windowsIdentityReady = configuration.windowsIdentityReady === true;

  if (typeof Notification !== "function"
      || typeof Notification.isSupported !== "function") {
    throw new TypeError("Notification constructor is required");
  }
  if (app === null || typeof app !== "object" || Array.isArray(app)) {
    throw new TypeError("app is required");
  }
  if (!Array.isArray(systemLocales)) {
    throw new TypeError("systemLocales must be an array");
  }

  const textOptions = { locale, systemLocales };

  function status() {
    const capability = capabilityStatus({
      Notification,
      app,
      platform,
      windowsIdentityReady,
    });
    return capability;
  }

  function deliver(value) {
    const notification = validateDesktopNotificationToDeliver(value);
    const capability = status();
    if (capability.status !== "ready") return capability;

    let copy;
    try {
      copy = copyForNotification(notification, textOptions);
      const nativeNotification = new Notification(copy);
      if (nativeNotification === null
          || typeof nativeNotification !== "object"
          || typeof nativeNotification.show !== "function") {
        return fixedStatus("native_error");
      }
      // Exactly one native object and one show call are created for each
      // accepted semantic output. Policy-level dedupe and one-per-refresh
      // selection remain the caller's responsibility.
      nativeNotification.show();
    } catch {
      return fixedStatus("native_error");
    }
    return fixedStatus("delivered");
  }

  return Object.freeze({
    status,
    deliver,
  });
}
