import {
  createPosixDesktopSettingsBackend,
  createWindowsDesktopSettingsBackend,
} from "./desktop-settings-backends.js";

export const DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION =
  "tibotattle-electron-update-preferences-v1";
export const DESKTOP_UPDATE_PREFERENCES_FILE_NAME = "update-preferences-v1.json";

const MAXIMUM_BYTES = 4_096;
const DEFAULT_PREFERENCES = Object.freeze({
  automaticDownload: true,
  schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION,
});

export class DesktopUpdatePreferencesError extends Error {
  constructor(code) {
    super("Desktop update preferences are unavailable");
    this.name = "DesktopUpdatePreferencesError";
    this.code = `desktop_update_preferences_${code}`;
  }
}

function fail(code) {
  throw new DesktopUpdatePreferencesError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  try {
    return Reflect.ownKeys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

export function validateDesktopUpdatePreferences(value) {
  if (!hasExactKeys(value, ["schemaVersion", "automaticDownload"])
      || value.schemaVersion !== DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION
      || typeof value.automaticDownload !== "boolean") {
    throw new TypeError("desktop update preferences are invalid");
  }
  return Object.freeze({
    schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION,
    automaticDownload: value.automaticDownload,
  });
}

export const DESKTOP_UPDATE_PREFERENCES_CODEC = Object.freeze({
  encode(value, maximumBytes) {
    const validated = validateDesktopUpdatePreferences(value);
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (maximumBytes !== undefined
        && (!Number.isSafeInteger(maximumBytes)
          || maximumBytes < 1
          || bytes.byteLength > maximumBytes)) {
      bytes.fill(0);
      throw new TypeError("desktop update preferences are too large");
    }
    return Object.freeze({ value: validated, bytes });
  },

  decodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("desktop update preference bytes are invalid");
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new TypeError("desktop update preference bytes are invalid");
    }
    return validateDesktopUpdatePreferences(value);
  },

  decodeValue(value) {
    return validateDesktopUpdatePreferences(value);
  },
});

function assertBackend(value) {
  if (!isPlainRecord(value)
      || typeof value.load !== "function"
      || typeof value.save !== "function") {
    throw new TypeError("desktop update preferences backend is required");
  }
  return value;
}

function snapshot(value, available) {
  return Object.freeze({
    automaticDownload: available && value.automaticDownload === true,
    available,
  });
}

/**
 * Persist the one updater preference apart from the ordinary desktop settings
 * record.  A damaged or unavailable record fails closed: manual checks remain
 * possible, but the updater cannot silently start a background download.
 */
export function createDesktopUpdatePreferences({ backend } = {}) {
  const persistence = assertBackend(backend);
  let loaded = false;
  let available = false;
  let value = DEFAULT_PREFERENCES;
  let operation = Promise.resolve();

  function enqueue(run) {
    const previous = operation;
    const current = previous.catch(() => {}).then(run);
    operation = current.catch(() => {});
    return current;
  }

  async function initializeInternal() {
    if (loaded) return snapshot(value, available);
    let stored;
    try {
      stored = await persistence.load();
    } catch {
      loaded = true;
      available = false;
      value = DEFAULT_PREFERENCES;
      return snapshot(value, available);
    }
    if (stored === null || stored === undefined) {
      try {
        await persistence.save(DEFAULT_PREFERENCES);
      } catch {
        loaded = true;
        available = false;
        value = DEFAULT_PREFERENCES;
        return snapshot(value, available);
      }
      value = DEFAULT_PREFERENCES;
      available = true;
      loaded = true;
      return snapshot(value, available);
    }
    try {
      value = validateDesktopUpdatePreferences(stored);
      available = true;
    } catch {
      value = DEFAULT_PREFERENCES;
      available = false;
    }
    loaded = true;
    return snapshot(value, available);
  }

  function initialize() {
    return enqueue(initializeInternal);
  }

  async function get() {
    await initialize();
    return snapshot(value, available);
  }

  async function setAutomaticDownload(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("automaticDownload is invalid");
    return enqueue(async () => {
      await initializeInternal();
      if (!available) fail("unavailable");
      const next = Object.freeze({
        schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION,
        automaticDownload: enabled,
      });
      try {
        await persistence.save(next);
      } catch {
        fail("persistence_failed");
      }
      value = next;
      return snapshot(value, true);
    });
  }

  return Object.freeze({
    get,
    initialize,
    setAutomaticDownload,
  });
}

/**
 * Use the same owner-only backend family as desktop settings while keeping a
 * separate exact child name.  Windows never falls back to an ordinary file.
 */
export function createDesktopUpdatePreferencesBackend({
  platform = process.platform,
  rootPath,
  windowsProtectedStateStore,
} = {}) {
  const options = {
    platform,
    rootPath,
    maximumBytes: MAXIMUM_BYTES,
    codec: DESKTOP_UPDATE_PREFERENCES_CODEC,
  };
  return platform === "win32"
    ? createWindowsDesktopSettingsBackend({
      ...options,
      childName: DESKTOP_UPDATE_PREFERENCES_FILE_NAME,
      windowsProtectedStateStore,
    })
    : createPosixDesktopSettingsBackend({
      ...options,
      filename: DESKTOP_UPDATE_PREFERENCES_FILE_NAME,
    });
}
