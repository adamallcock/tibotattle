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
const CRASH_COPY_KEYS = [
  "electron.diagnostics.enableCapture",
  "electron.diagnostics.disableCapture",
  "electron.diagnostics.openCrashFolder",
  "electron.diagnostics.prepareSupportIssue",
  "electron.diagnostics.message",
  "electron.diagnostics.title",
];
const EXPECTED_CRASH_COPY = {
  "electron.diagnostics.enableCapture": {
    "en-US": "Enable local crash capture next launch",
    "zh-Hans": "下次启动时启用本地崩溃捕获",
    "es": "Activar captura local al reiniciar",
  },
  "electron.diagnostics.disableCapture": {
    "en-US": "Disable local crash capture next launch",
    "zh-Hans": "下次启动时停用本地崩溃捕获",
    "es": "Desactivar captura local al reiniciar",
  },
  "electron.diagnostics.openCrashFolder": {
    "en-US": "Open local crash reports",
    "zh-Hans": "打开本地崩溃报告",
    "es": "Abrir informes de fallos locales",
  },
  "electron.diagnostics.prepareSupportIssue": {
    "en-US": "Prepare public GitHub issue…",
    "zh-Hans": "准备公开的 GitHub 问题…",
    "es": "Preparar incidencia pública en GitHub…",
  },
  "electron.diagnostics.message": {
    "en-US": "Review this content-free report. Preparing a public issue sends it to GitHub in the URL; review the form before submitting. Local crash dumps may contain private data and are not uploaded by TiboTattle. Capture changes take effect after restart.",
    "zh-Hans": "请查看这份不含内容的报告。准备公开问题会通过网址将报告发送给 GitHub；提交前请检查表单。本地崩溃转储可能包含私密数据，TiboTattle 不会上传它们。捕获设置会在重启后生效。",
    "es": "Revisa este informe sin contenido. Preparar una incidencia pública lo envía a GitHub en la URL; revisa el formulario antes de publicarlo. Los volcados locales pueden contener datos privados y TiboTattle no los sube. Los cambios de captura se aplican tras reiniciar.",
  },
  "electron.diagnostics.title": {
    "en-US": "TiboTattle doctor",
    "zh-Hans": "TiboTattle 诊断工具",
    "es": "Diagnóstico de TiboTattle",
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
  assert.equal(Object.keys(DESKTOP_OVERLAY_MESSAGES).length, 90);
  assert.deepEqual(Object.keys(DESKTOP_OVERRIDES).sort(), [...OVERRIDE_KEYS].sort());
  assert.deepEqual(DESKTOP_SHARED_KEYS, desktopOwnership.DESKTOP_SHARED_KEYS);
  assert.deepEqual(DESKTOP_OVERLAY_MESSAGES, desktopOwnership.DESKTOP_OVERLAY_MESSAGES);
  assert.deepEqual(DESKTOP_OVERRIDES, desktopOwnership.DESKTOP_OVERRIDES);
  assert.equal(Object.keys(DESKTOP_MESSAGES).length, 132);
  assert.deepEqual(
    Object.fromEntries(CRASH_COPY_KEYS.map((key) => [key, DESKTOP_OVERLAY_MESSAGES[key]])),
    EXPECTED_CRASH_COPY,
  );

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
