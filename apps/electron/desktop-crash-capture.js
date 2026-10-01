import { createPosixDesktopSettingsBackend } from "./desktop-settings-backends.js";

export const DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION = "tibotattle-electron-crash-capture-v1";
export const DESKTOP_CRASH_CAPTURE_FILE_NAME = "crash-capture-v1.json";

const DEFAULT_PREFERENCE = Object.freeze({
  schemaVersion: DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION,
  enabled: false,
});

function validatePreference(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 2
      || !Object.hasOwn(value, "schemaVersion")
      || !Object.hasOwn(value, "enabled")
      || value.schemaVersion !== DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION
      || typeof value.enabled !== "boolean") {
    throw new TypeError("crash capture preference is invalid");
  }
  return Object.freeze({ schemaVersion: DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION, enabled: value.enabled });
}

const codec = Object.freeze({
  encode(value, maximumBytes) {
    const validated = validatePreference(value);
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (bytes.byteLength > maximumBytes) throw new TypeError("crash capture preference is too large");
    return Object.freeze({ value: validated, bytes });
  },
  decodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("crash capture bytes are invalid");
    return validatePreference(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  },
  decodeValue: validatePreference,
});

export function createDesktopCrashCaptureBackend({ rootPath, platform = process.platform } = {}) {
  if (platform !== "darwin") throw new TypeError("crash capture is supported on macOS only");
  return createPosixDesktopSettingsBackend({
    platform,
    rootPath,
    filename: DESKTOP_CRASH_CAPTURE_FILE_NAME,
    maximumBytes: 512,
    codec,
  });
}

/** The preference is independent of hosted contribution and never authorizes upload. */
export function createDesktopCrashCapture({ backend, crashReporter } = {}) {
  if (!backend || typeof backend.load !== "function" || typeof backend.save !== "function"
      || !crashReporter || typeof crashReporter.start !== "function") {
    throw new TypeError("crash capture dependencies are unavailable");
  }
  let preference = DEFAULT_PREFERENCE;
  let available = false;
  let active = false;
  let initialized = false;
  let operation = Promise.resolve();

  function snapshot() {
    return Object.freeze({ available, enabled: available && preference.enabled, active });
  }

  async function initializeInternal() {
    if (initialized) return snapshot();
    initialized = true;
    try {
      const stored = await backend.load();
      preference = stored === null || stored === undefined
        ? DEFAULT_PREFERENCE : validatePreference(stored);
      available = true;
    } catch {
      // A corrupt or inaccessible preference cannot enable memory-bearing dumps.
      preference = DEFAULT_PREFERENCE;
      available = false;
    }
    if (available && preference.enabled) {
      try {
        crashReporter.start({ uploadToServer: false });
        active = true;
      } catch {
        active = false;
      }
    }
    return snapshot();
  }

  function enqueue(run) {
    const next = operation.catch(() => {}).then(run);
    operation = next.catch(() => {});
    return next;
  }

  function initialize() { return enqueue(initializeInternal); }
  function get() { return enqueue(initializeInternal); }
  function setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled is invalid");
    return enqueue(async () => {
      await initializeInternal();
      if (!available) return snapshot();
      const next = Object.freeze({ schemaVersion: DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION, enabled });
      try {
        const latest = await backend.load();
        if (latest !== null && latest !== undefined) validatePreference(latest);
        await backend.save(next);
      } catch {
        // In particular, an older app must not replace a newer schema.
        available = false;
        return snapshot();
      }
      preference = next;
      // Crashpad cannot be stopped once started. A change applies on restart.
      return snapshot();
    });
  }

  return Object.freeze({ initialize, get, setEnabled });
}
