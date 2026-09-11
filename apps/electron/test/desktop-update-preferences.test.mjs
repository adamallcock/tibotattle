import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopUpdatePreferences,
  DESKTOP_UPDATE_PREFERENCES_CODEC,
  DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION,
  validateDesktopUpdatePreferences,
} from "../desktop-update-preferences.js";

function backend({ value = null, loadError = null, saveError = null } = {}) {
  const saved = [];
  return {
    saved,
    async load() {
      if (loadError) throw loadError;
      return value;
    },
    async save(next) {
      if (saveError) throw saveError;
      value = next;
      saved.push(next);
    },
  };
}

test("update preferences create and persist a closed default record", async () => {
  const persistence = backend();
  const preferences = createDesktopUpdatePreferences({ backend: persistence });

  assert.deepEqual(await preferences.get(), { automaticDownload: true, available: true });
  assert.deepEqual(persistence.saved, [{
    automaticDownload: true,
    schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION,
  }]);
  assert.deepEqual(await preferences.setAutomaticDownload(false), {
    automaticDownload: false,
    available: true,
  });
  assert.deepEqual(await preferences.get(), { automaticDownload: false, available: true });
  assert.deepEqual(persistence.saved.at(-1), {
    automaticDownload: false,
    schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION,
  });
});

test("damaged or unavailable update preferences fail closed without enabling downloads", async () => {
  const damaged = createDesktopUpdatePreferences({ backend: backend({ value: {
    automaticDownload: true,
    schemaVersion: "unexpected",
  } }) });
  assert.deepEqual(await damaged.get(), { automaticDownload: false, available: false });
  await assert.rejects(
    damaged.setAutomaticDownload(true),
    (error) => error?.code === "desktop_update_preferences_unavailable",
  );

  const unavailable = createDesktopUpdatePreferences({ backend: backend({
    loadError: new Error("store unavailable"),
  }) });
  assert.deepEqual(await unavailable.initialize(), { automaticDownload: false, available: false });
});

test("update preferences codec has one exact bounded schema", () => {
  const expected = {
    automaticDownload: false,
    schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION,
  };
  const encoded = DESKTOP_UPDATE_PREFERENCES_CODEC.encode(expected, 4_096);
  assert.deepEqual(encoded.value, expected);
  assert.deepEqual(DESKTOP_UPDATE_PREFERENCES_CODEC.decodeBytes(encoded.bytes), expected);
  assert.equal(Object.isFrozen(encoded.value), true);
  for (const value of [
    {},
    { schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION },
    { automaticDownload: false, schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION, extra: true },
    { automaticDownload: "false", schemaVersion: DESKTOP_UPDATE_PREFERENCES_SCHEMA_VERSION },
  ]) {
    assert.throws(() => validateDesktopUpdatePreferences(value), /invalid/u);
  }
  assert.throws(
    () => DESKTOP_UPDATE_PREFERENCES_CODEC.encode(expected, 1),
    /too large/u,
  );
});
