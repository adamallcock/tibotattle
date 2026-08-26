import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_DEFAULT_SETTINGS,
  projectDesktopSettingsPathFree,
} from "../desktop-contract.js";
import {
  createDesktopSettingsStore,
} from "../desktop-settings-store.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const ROOT_A = "11111111-1111-4111-8111-111111111111";
const ROOT_B = "22222222-2222-4222-8222-222222222222";

function customHomes(path = "D:\\Codex", rootId = ROOT_A) {
  return {
    activityRoots: [{ rootId, kind: "custom", path, enabled: true }],
    primaryRootId: rootId,
  };
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
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree(DESKTOP_DEFAULT_SETTINGS));
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
    codexHomes: customHomes(),
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
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree(persisted));
  assert.deepEqual(await store.getCodexHomesForSettings(), persisted.codexHomes);
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
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree({
    ...DESKTOP_DEFAULT_SETTINGS,
    language: "en",
    refreshIntervalSeconds: 900,
  }));
  assert.equal((await store.setStartAtLogin(false)).startAtLogin, false);
});

test("settings load failures fail soft to defaults without exposing backend details", async () => {
  const store = createDesktopSettingsStore({
    backend: {
      async load() { throw new Error("private path detail"); },
      async save() {},
    },
  });
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree(DESKTOP_DEFAULT_SETTINGS));
  assert.equal(store.lastLoadFailed, true);
});

test("store migrates v1 once and retains the generated root ID", async () => {
  const legacy = {
    schemaVersion: "tibotattle-desktop-settings-v1",
    codexHome: { mode: "custom", path: "D:\\Codex" },
    language: "en",
    appearance: "system",
    refreshIntervalSeconds: 300,
    startAtLogin: false,
    notifications: { enabled: false, threshold: "off" },
  };
  const saves = [];
  const store = createDesktopSettingsStore({
    idFactory: () => ROOT_A,
    backend: {
      async load() { return legacy; },
      async save(value) { saves.push(clone(value)); },
    },
  });
  assert.equal((await store.getCodexHomesForSettings()).activityRoots[0].rootId, ROOT_A);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].schemaVersion, "tibotattle-desktop-settings-v2");
  assert.equal(saves[0].codexHomes.activityRoots[0].path, "D:\\Codex");
  assert.equal(store.lastLoadFailed, false);
});

test("store root mutations are bounded, atomic, and preserve primary on reorder", async () => {
  const writes = [];
  let failNext = false;
  const store = createDesktopSettingsStore({
    idFactory: () => ROOT_B,
    backend: {
      async load() { return { ...DESKTOP_DEFAULT_SETTINGS, codexHomes: customHomes() }; },
      async save(value) {
        writes.push(clone(value));
        if (failNext) {
          failNext = false;
          throw new Error("disk unavailable");
        }
      },
    },
  });
  await store.getSettings();
  await store.addCodexHome({ path: "C:\\Users\\test\\secondary" });
  let roots = await store.getCodexHomesForSettings();
  assert.deepEqual(roots.activityRoots.map((root) => root.rootId), [ROOT_A, ROOT_B]);
  await store.setPrimaryCodexHome({ rootId: ROOT_B });
  await store.reorderCodexHomes({ rootIds: [ROOT_B, ROOT_A] });
  roots = await store.getCodexHomesForSettings();
  assert.equal(roots.primaryRootId, ROOT_B);
  assert.deepEqual(roots.activityRoots.map((root) => root.rootId), [ROOT_B, ROOT_A]);
  await store.editCodexHome({ rootId: ROOT_A, path: "/Users/test/edited" });
  assert.equal((await store.getCodexHomesForSettings()).activityRoots[1].path, "/Users/test/edited");
  await store.removeCodexHome({ rootId: ROOT_A });
  assert.deepEqual((await store.getCodexHomesForSettings()).activityRoots.map((root) => root.rootId), [ROOT_B]);

  await store.useDefaultCodexHome();
  assert.deepEqual(await store.getCodexHomesForSettings(), DESKTOP_DEFAULT_SETTINGS.codexHomes);
  failNext = true;
  await assert.rejects(store.addCodexHome({ path: "/Users/test/after-failure" }), (error) => {
    assert.equal(error.code, "desktop_settings_persistence_failed");
    return true;
  });
  assert.deepEqual(await store.getCodexHomesForSettings(), DESKTOP_DEFAULT_SETTINGS.codexHomes);
  assert.equal(writes.length > 0, true);
});

test("store rejects malformed root operations before a backend write", async () => {
  const saves = [];
  const store = createDesktopSettingsStore({
    backend: {
      async load() { return null; },
      async save(value) { saves.push(value); },
    },
  });
  await store.getSettings();
  await assert.rejects(store.addCodexHome({ path: "relative" }), TypeError);
  await assert.rejects(store.removeCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }), TypeError);
  await assert.rejects(store.reorderCodexHomes({ rootIds: [] }), TypeError);
  assert.equal(saves.length, 0);
});
