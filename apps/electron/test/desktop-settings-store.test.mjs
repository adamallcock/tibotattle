import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_DEFAULT_SETTINGS,
} from "../desktop-contract.js";
import {
  createDesktopSettingsStore,
} from "../desktop-settings-store.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("settings store uses exact defaults and a dependency-injected backend", async () => {
  const calls = [];
  const backend = {
    async load() {
      calls.push("load");
      return null;
    },
    async save(snapshot) {
      calls.push({ save: clone(snapshot) });
    },
  };
  const store = createDesktopSettingsStore({ backend });
  assert.deepEqual(await store.getSettings(), DESKTOP_DEFAULT_SETTINGS);
  assert.equal(store.lastLoadFailed, false);
  assert.deepEqual(calls, ["load"]);
  const result = await store.setLanguage("es");
  assert.equal(result.language, "es");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].save, {
    ...DESKTOP_DEFAULT_SETTINGS,
    language: "es",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.notifications), true);
});
test("settings store restores a valid persisted snapshot and rejects malformed updates", async () => {
  const persisted = {
    ...DESKTOP_DEFAULT_SETTINGS,
    codexHome: { mode: "custom", path: "D:\\Codex" },
    language: "zh-Hans",
    refreshIntervalSeconds: 900,
    startAtLogin: true,
    notifications: { enabled: true, threshold: "ninety" },
  };
  const store = createDesktopSettingsStore({
    backend: {
      async load() { return persisted; },
      async save() {},
    },
  });
  assert.deepEqual(await store.getSettings(), persisted);
  await assert.rejects(store.setLanguage("fr"), TypeError);
  await assert.rejects(store.setRefreshInterval(5), TypeError);
  await assert.rejects(store.setNotificationPreferences({
    enabled: true,
    threshold: "90",
  }), TypeError);
  await assert.rejects(store.setNotificationPreferences({
    enabled: true,
    threshold: "ninety",
    extra: true,
  }), TypeError);
  assert.equal((await store.setAppearance("dark")).appearance, "dark");
  await assert.rejects(store.setAppearance("sepia"), TypeError);
});

test("settings writes are serialized and retain the last working state after failure", async () => {
  const saves = [];
  let rejectNext = false;
  const backend = {
    async load() { return null; },
    async save(snapshot) {
      saves.push(clone(snapshot));
      if (rejectNext) {
        rejectNext = false;
        throw new Error("backend unavailable");
      }
    },
  };
  const store = createDesktopSettingsStore({ backend });
  await store.getSettings();
  const first = store.setLanguage("en");
  const second = store.setRefreshInterval(900);
  assert.equal((await first).language, "en");
  assert.equal((await second).refreshIntervalSeconds, 900);
  assert.equal((await store.getSettings()).language, "en");
  assert.equal((await store.getSettings()).refreshIntervalSeconds, 900);
  assert.equal(saves.length, 2);
  assert.equal(saves[1].language, "en");

  rejectNext = true;
  await assert.rejects(store.setStartAtLogin(true), (error) => {
    assert.equal(error.code, "desktop_settings_persistence_failed");
    return true;
  });
  assert.deepEqual(await store.getSettings(), {
    ...DESKTOP_DEFAULT_SETTINGS,
    language: "en",
    refreshIntervalSeconds: 900,
  });
  assert.equal((await store.setStartAtLogin(false)).startAtLogin, false);
});

test("settings load failures fail soft to defaults without exposing backend details", async () => {
  const store = createDesktopSettingsStore({
    backend: {
      async load() { throw new Error("private path detail"); },
      async save() {},
    },
  });
  assert.deepEqual(await store.getSettings(), DESKTOP_DEFAULT_SETTINGS);
  assert.equal(store.lastLoadFailed, true);
});
