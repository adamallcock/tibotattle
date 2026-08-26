import {
  DESKTOP_DEFAULT_SETTINGS,
  DESKTOP_LANGUAGES,
  DESKTOP_NOTIFICATION_THRESHOLDS,
  DESKTOP_APPEARANCES,
  DESKTOP_REFRESH_INTERVAL_SECONDS,
  DESKTOP_SETTINGS_LEGACY_MIGRATION_MARKER,
  DESKTOP_SETTINGS_SCHEMA_VERSION,
  migrateDesktopSettingsSnapshot,
  projectDesktopSettingsPathFree,
  validateDesktopSettingsSnapshot,
} from "./desktop-contract.js";
import {
  addCodexHomeToConfiguration,
  createDefaultCodexHomes,
  editCodexHomeInConfiguration,
  migrateLegacyCodexHome,
  normalizeCodexHomes,
  projectCodexHomesForSettings,
  removeCodexHomeFromConfiguration,
  reorderCodexHomesConfiguration,
  setPrimaryCodexHomeInConfiguration,
} from "./desktop-codex-roots.js";

const DEFAULT_BACKEND = Object.freeze({
  async load() {
    return null;
  },
  async save() {},
});

const UPDATE_KEYS = Object.freeze([
  "codexHome",
  "codexHomes",
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

function defaultSettings() {
  return validateDesktopSettingsSnapshot({
    schemaVersion: DESKTOP_DEFAULT_SETTINGS.schemaVersion,
    codexHomes: DESKTOP_DEFAULT_SETTINGS.codexHomes,
    language: DESKTOP_DEFAULT_SETTINGS.language,
    appearance: DESKTOP_DEFAULT_SETTINGS.appearance,
    refreshIntervalSeconds: DESKTOP_DEFAULT_SETTINGS.refreshIntervalSeconds,
    startAtLogin: DESKTOP_DEFAULT_SETTINGS.startAtLogin,
    notifications: { ...DESKTOP_DEFAULT_SETTINGS.notifications },
    sidebarCollapsed: DESKTOP_DEFAULT_SETTINGS.sidebarCollapsed,
  });
}

function cloneSettings(settings, idFactory) {
  const migrated = migrateDesktopSettingsSnapshot(settings, { idFactory });
  return validateDesktopSettingsSnapshot({
    schemaVersion: migrated.schemaVersion,
    codexHomes: migrated.codexHomes,
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

/**
 * A serialized, dependency-injected settings store.  It owns no filesystem
 * implementation: production chooses the backend appropriate to the host
 * platform, while tests can provide an in-memory or failure-injecting port.
 */
export function createDesktopSettingsStore({ backend = DEFAULT_BACKEND, idFactory } = {}) {
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
          const migrated = migrateDesktopSettingsSnapshot(stored, { idFactory });
          state = cloneSettings(migrated, idFactory);
          // Persist a legacy migration as one normal backend transaction. The
          // backend owns its atomic/no-clobber publication boundary. Keep the
          // migrated state usable in memory if that publication is unavailable
          // and expose only a fixed diagnostic to the caller.
          if (stored.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION
              || stored[DESKTOP_SETTINGS_LEGACY_MIGRATION_MARKER] === true) {
            try {
              await persistence.save(state);
            } catch (error) {
              lastLoadError = loadError();
              void error;
            }
          }
        }
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
    const candidate = cloneSettings(next, idFactory);
    try {
      await persistence.save(candidate);
    } catch (error) {
      void error;
      // Do not advance state until persistence succeeds. A failed write leaves
      // the last known-good snapshot available to the renderer.
      throw persistenceError();
    }
    state = candidate;
    lastLoadError = null;
    return projectDesktopSettingsPathFree(state);
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
    if (Object.hasOwn(patch, "codexHome") && Object.hasOwn(patch, "codexHomes")) {
      throw new TypeError("codexHome and codexHomes are mutually exclusive");
    }
    return enqueueUpdate((current) => {
      let codexHomes = current.codexHomes;
      if (Object.hasOwn(patch, "codexHomes")) {
        codexHomes = normalizeCodexHomes(patch.codexHomes);
      } else if (Object.hasOwn(patch, "codexHome")) {
        codexHomes = migrateLegacyCodexHome(patch.codexHome, { idFactory });
      }
      return {
        ...current,
        codexHomes,
        language: patch.language === undefined ? current.language : patch.language,
        appearance: patch.appearance === undefined ? current.appearance : patch.appearance,
        refreshIntervalSeconds: patch.refreshIntervalSeconds === undefined
          ? current.refreshIntervalSeconds
          : patch.refreshIntervalSeconds,
        startAtLogin: patch.startAtLogin === undefined
          ? current.startAtLogin
          : patch.startAtLogin,
        notifications: patch.notifications === undefined
          ? { ...current.notifications }
          : { ...patch.notifications },
        sidebarCollapsed: patch.sidebarCollapsed === undefined
          ? current.sidebarCollapsed
          : patch.sidebarCollapsed,
      };
    });
  }

  async function getSettings() {
    await ensureLoaded();
    return projectDesktopSettingsPathFree(state);
  }

  async function getPersistedSettings() {
    await ensureLoaded();
    return cloneSettings(state, idFactory);
  }

  async function getCodexHomesForSettings() {
    await ensureLoaded();
    return projectCodexHomesForSettings(state.codexHomes);
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
    const codexHomes = migrateLegacyCodexHome(home, { idFactory });
    return enqueueUpdate((current) => ({ ...current, codexHomes }));
  }

  async function addCodexHome(options = {}) {
    assertExactKeys(options, ["path"], "addCodexHome");
    return enqueueUpdate((current) => ({
      ...current,
      codexHomes: addCodexHomeToConfiguration(current.codexHomes, {
        path: options.path,
        idFactory,
      }),
    }));
  }

  async function editCodexHome(options = {}) {
    assertExactKeys(options, ["rootId", "path"], "editCodexHome");
    return enqueueUpdate((current) => ({
      ...current,
      codexHomes: editCodexHomeInConfiguration(current.codexHomes, options),
    }));
  }

  async function removeCodexHome(options = {}) {
    assertExactKeys(options, ["rootId"], "removeCodexHome");
    return enqueueUpdate((current) => ({
      ...current,
      codexHomes: removeCodexHomeFromConfiguration(current.codexHomes, options),
    }));
  }

  async function setPrimaryCodexHome(options = {}) {
    assertExactKeys(options, ["rootId"], "setPrimaryCodexHome");
    return enqueueUpdate((current) => ({
      ...current,
      codexHomes: setPrimaryCodexHomeInConfiguration(current.codexHomes, options),
    }));
  }

  async function reorderCodexHomes(options = {}) {
    assertExactKeys(options, ["rootIds"], "reorderCodexHomes");
    return enqueueUpdate((current) => ({
      ...current,
      codexHomes: reorderCodexHomesConfiguration(current.codexHomes, options),
    }));
  }

  async function useDefaultCodexHome() {
    return enqueueUpdate((current) => ({
      ...current,
      codexHomes: createDefaultCodexHomes(),
    }));
  }

  return Object.freeze({
    getSettings,
    getPersistedSettings,
    getCodexHomesForSettings,
    update,
    updateSnapshot,
    setLanguage,
    setAppearance,
    setRefreshInterval,
    setStartAtLogin,
    setNotificationPreferences,
    setSidebarCollapsed,
    setCodexHome,
    addCodexHome,
    editCodexHome,
    removeCodexHome,
    setPrimaryCodexHome,
    reorderCodexHomes,
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
