import assert from "node:assert/strict";
import test from "node:test";

import * as canonical from "../../../packages/i18n/index.js";
import {
  I18N_ELECTRON_COPY_FILE,
  buildI18nElectronCopy,
  checkI18nElectronCopy,
} from "../../../scripts/generate-i18n-electron-copy.js";
import {
  DESKTOP_MESSAGES,
  DESKTOP_OVERLAY_MESSAGES,
  DESKTOP_OVERRIDES,
  DESKTOP_SHARED_KEYS,
  DESKTOP_SUPPORTED_LOCALES,
  canonicalizeLocale,
  negotiateLocale,
} from "../desktop-copy.js";
import * as desktopOwnership from "../desktop-copy-source.js";

const OVERRIDE_KEYS = [
  "electron.menu.refresh",
  "electron.settings.codexFolder.title",
  "electron.settings.codexFolder.useDefault",
];
const EXPECTED_OVERRIDES = {
  "electron.menu.refresh": {
    "en-US": "Update Local Usage",
    "zh-Hans": "更新本地使用情况",
    "es": "Actualizar uso local",
  },
  "electron.settings.codexFolder.title": {
    "en-US": "Choose Codex folder",
    "zh-Hans": "选择 Codex 文件夹",
    "es": "Elegir carpeta de Codex",
  },
  "electron.settings.codexFolder.useDefault": {
    "en-US": "Use this folder",
    "zh-Hans": "使用此文件夹",
    "es": "Usar esta carpeta",
  },
};

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu)]
    .map(([, key]) => key)
    .sort();
}

test("Electron localization is generated, bounded, and ownership-stable", async () => {
  assert.equal(await checkI18nElectronCopy(), true);
  assert.equal(I18N_ELECTRON_COPY_FILE.endsWith("apps/electron/desktop-copy.js"), true);
  assert.equal(DESKTOP_SHARED_KEYS.length, 39);
  assert.equal(Object.keys(DESKTOP_OVERLAY_MESSAGES).length, 86);
  assert.deepEqual(Object.keys(DESKTOP_OVERRIDES).sort(), [...OVERRIDE_KEYS].sort());
  assert.deepEqual(DESKTOP_SHARED_KEYS, desktopOwnership.DESKTOP_SHARED_KEYS);
  assert.deepEqual(DESKTOP_OVERLAY_MESSAGES, desktopOwnership.DESKTOP_OVERLAY_MESSAGES);
  assert.deepEqual(DESKTOP_OVERRIDES, desktopOwnership.DESKTOP_OVERRIDES);
  assert.equal(Object.keys(DESKTOP_MESSAGES).length, 128);

  for (const key of DESKTOP_SHARED_KEYS) {
    for (const locale of DESKTOP_SUPPORTED_LOCALES) {
      assert.equal(DESKTOP_MESSAGES[key][locale], canonical.CATALOGS[locale][key], key);
      assert.deepEqual(placeholders(DESKTOP_MESSAGES[key][locale]), placeholders(canonical.CATALOGS[locale][key]), key);
    }
  }
  for (const key of OVERRIDE_KEYS) {
    assert.deepEqual(DESKTOP_OVERRIDES[key], EXPECTED_OVERRIDES[key], key);
    assert.notDeepEqual(DESKTOP_OVERRIDES[key], Object.fromEntries(
      DESKTOP_SUPPORTED_LOCALES.map((locale) => [locale, canonical.CATALOGS[locale][key]]),
    ), key);
  }
  assert.equal(canonicalizeLocale("en-us"), canonical.canonicalizeLocale("en-us"));
  for (const value of [
    "en-US",
    "en",
    "zh",
    "zh-CN",
    "zh-SG",
    "zh-Hans-CN",
    "zh-TW",
    "zh-Hant",
    "es-MX",
    " ZH-hans-cn ",
    "invalid_locale",
    null,
    [],
    ["zh-TW", "es-MX"],
    ["invalid_locale", "zh-CN"],
  ]) {
    assert.equal(negotiateLocale(value), canonical.negotiateLocale(value), value);
  }
  assert.doesNotMatch(await buildI18nElectronCopy(), /(?:from\s+["']|import\s*\()/u);
});
