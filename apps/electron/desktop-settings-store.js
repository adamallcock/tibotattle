import {
  DESKTOP_DEFAULT_SETTINGS,
  DESKTOP_LANGUAGES,
  DESKTOP_NOTIFICATION_THRESHOLDS,
  DESKTOP_APPEARANCES,
  DESKTOP_REFRESH_INTERVAL_SECONDS,
  DESKTOP_SETTINGS_SCHEMA_VERSION,
  migrateDesktopSettingsSnapshot,
  validateDesktopSettingsSnapshot,
} from "./desktop-contract.js";

const DEFAULT_BACKEND = Object.freeze({
  async load() {
    return null;
  },
  async save() {},
});

const UPDATE_KEYS = Object.freeze([
  "codexHome",
  "language",
  "appearance",
  "refreshIntervalSeconds",
  "startAtLogin",
  "notifications",
  "sidebarCollapsed",
]);

function assertBackend(backend) {
  if (backend === null || typeof backend !== "object" || Array.isArray(backend)) {
    throw new TypeError("backend must be an object");
  }
  if (typeof backend.load !== "function" || typeof backend.save !== "function") {
    throw new TypeError("backend must implement load and save");
  }
  return backend;
}

function cloneSettings(settings) {
  const migrated = migrateDesktopSettingsSnapshot(settings);
  return validateDesktopSettingsSnapshot({
    schemaVersion: migrated.schemaVersion,
    codexHome: { ...migrated.codexHome },
    language: migrated.language,
    appearance: migrated.appearance,
    refreshIntervalSeconds: migrated.refreshIntervalSeconds,
    startAtLogin: migrated.startAtLogin,
    notifications: { ...migrated.notifications },
    sidebarCollapsed: migrated.sidebarCollapsed,
  });
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has unexpected keys`);
  }
}

function persistenceError() {
  const error = new Error("Desktop settings persistence failed");
  error.name = "DesktopSettingsPersistenceError";
  error.code = "desktop_settings_persistence_failed";
  return error;
}

function loadError() {
  const error = new Error("Desktop settings load failed");
  error.name = "DesktopSettingsLoadError";
  error.code = "desktop_settings_load_failed";
  return error;
}

function defaultSettings() {
  return cloneSettings(DESKTOP_DEFAULT_SETTINGS);
}

/**
 * A serialized, dependency-injected settings store.  It owns no filesystem
 * implementation: production chooses the backend appropriate to the host
 * platform, while tests can provide an in-memory or failure-injecting port.
 */
export function createDesktopSettingsStore({ backend = DEFAULT_BACKEND } = {}) {
  const persistence = assertBackend(backend);
  let state = defaultSettings();
  let loaded = false;
  let loadPromise = null;
  let operation = Promise.resolve();
  let lastLoadError = null;

  async function ensureLoaded() {
    if (loaded) return state;
    if (loadPromise !== null) return loadPromise;
    loadPromise = (async () => {
      try {
        const stored = await persistence.load();
        if (stored === null || stored === undefined) {
          state = defaultSettings();
        } else {
          state = cloneSettings(stored);
        }
        lastLoadError = null;
      } catch (error) {
        // A corrupt/unavailable preference backend must never make the desktop
        // shell unusable. Keep the exact defaults and expose only a fixed
        // diagnostic through the store state, never the backend error.
        state = defaultSettings();
        lastLoadError = loadError();
        void error;
      }
      loaded = true;
      return state;
    })();
    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  function enqueue(run) {
    const previous = operation;
    const current = previous.catch(() => {}).then(run);
    operation = current.catch(() => {});
    return current;
  }

  async function save(next) {
    const candidate = cloneSettings(next);
    try {
      await persistence.save(candidate);
    } catch (error) {
      void error;
      // Do not advance state until persistence succeeds. A failed write leaves
      // the last known-good snapshot available to the renderer.
      throw persistenceError();
    }
    state = candidate;
    return state;
  }

  async function updateSnapshot(next) {
    await ensureLoaded();
    return enqueue(() => save(next));
  }

  async function enqueueUpdate(mutator) {
    await ensureLoaded();
    return enqueue(() => save(mutator(state)));
  }

  async function update(patch) {
    await ensureLoaded();
    if (!isPlainRecord(patch)) throw new TypeError("update must be an object");
    const keys = Reflect.ownKeys(patch);
    if (keys.length === 0 || keys.some((key) => !UPDATE_KEYS.includes(key))) {
      throw new TypeError("update has unexpected keys");
    }
    return enqueueUpdate((current) => ({
      ...current,
      ...patch,
      codexHome: patch.codexHome === undefined
        ? { ...current.codexHome }
        : { ...patch.codexHome },
      notifications: patch.notifications === undefined
        ? { ...current.notifications }
        : { ...patch.notifications },
    }));
  }

  async function getSettings() {
    await ensureLoaded();
    return state;
  }

  async function setLanguage(language) {
    if (!DESKTOP_LANGUAGES.includes(language)) throw new TypeError("language is invalid");
    return enqueueUpdate((current) => ({ ...current, language }));
  }

  async function setAppearance(appearance) {
    if (!DESKTOP_APPEARANCES.includes(appearance)) {
      throw new TypeError("appearance is invalid");
    }
    return enqueueUpdate((current) => ({ ...current, appearance }));
  }

  async function setRefreshInterval(seconds) {
    if (!DESKTOP_REFRESH_INTERVAL_SECONDS.includes(seconds)) {
      throw new TypeError("seconds is invalid");
    }
    return enqueueUpdate((current) => ({ ...current, refreshIntervalSeconds: seconds }));
  }

  async function setStartAtLogin(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled is invalid");
    return enqueueUpdate((current) => ({ ...current, startAtLogin: enabled }));
  }

  async function setNotificationPreferences(preferences) {
    assertExactKeys(preferences, ["enabled", "threshold"], "preferences");
    if (typeof preferences.enabled !== "boolean") {
      throw new TypeError("enabled is invalid");
    }
    if (!DESKTOP_NOTIFICATION_THRESHOLDS.includes(preferences.threshold)) {
      throw new TypeError("threshold is invalid");
    }
    return enqueueUpdate((current) => ({
      ...current,
      notifications: { ...preferences },
    }));
  }

  async function setSidebarCollapsed(collapsed) {
    if (typeof collapsed !== "boolean") throw new TypeError("collapsed is invalid");
    return enqueueUpdate((current) => ({ ...current, sidebarCollapsed: collapsed }));
  }

  async function setCodexHome(home) {
    assertExactKeys(home, ["mode", "path"], "codexHome");
    if (![
      "default",
      "custom",
    ].includes(home.mode)) throw new TypeError("codexHome.mode is invalid");
    if (home.mode === "default" && home.path !== null) {
      throw new TypeError("default codexHome.path must be null");
    }
    if (home.mode === "custom"
        && (typeof home.path !== "string" || home.path.length === 0 || home.path.includes("\0"))) {
      throw new TypeError("custom codexHome.path is invalid");
    }
    return enqueueUpdate((current) => ({ ...current, codexHome: { ...home } }));
  }

  async function useDefaultCodexHome() {
    return setCodexHome({ mode: "default", path: null });
  }

  return Object.freeze({
    getSettings,
    update,
    updateSnapshot,
    setLanguage,
    setAppearance,
    setRefreshInterval,
    setStartAtLogin,
    setNotificationPreferences,
    setSidebarCollapsed,
    setCodexHome,
    useDefaultCodexHome,
    get lastLoadFailed() {
      return lastLoadError !== null;
    },
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
  });
}

export {
  DEFAULT_BACKEND as DEFAULT_DESKTOP_SETTINGS_BACKEND,
  UPDATE_KEYS as DESKTOP_SETTINGS_UPDATE_KEYS,
};
