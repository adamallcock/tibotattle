import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MODEL_COMPOSITION_POLICY,
} from "../../../packages/quota-analysis/index.js";
import {
  COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT,
  LEGACY_TEXT_CATALOG,
  SUPPORTED_LOCALES,
  WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP,
  WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES,
  translate,
  translateLegacyText,
} from "../public/localization.js";

test("unavailable fitted-rate copy follows the weekly calibration contract", async () => {
  const contractSource = await readFile(
    new URL("../../../src/reporting/weekly-calibration.js", import.meta.url),
    "utf8",
  );
  const pointMinimumMatch = contractSource.match(
    /if \(points\.length < (\d+)\)/u,
  );
  const spanMinimumMatch = contractSource.match(
    /if \(fullSpanPp < (\d+)\)/u,
  );
  assert.ok(pointMinimumMatch, "weekly calibration point minimum is present in the contract");
  assert.ok(spanMinimumMatch, "weekly calibration span minimum is present in the contract");
  const contractPointMinimum = Number(pointMinimumMatch[1]);
  const contractSpanMinimum = Number(spanMinimumMatch[1]);
  assert.equal(
    WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES,
    contractPointMinimum,
  );
  assert.equal(
    WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP,
    contractSpanMinimum,
  );

  for (const locale of SUPPORTED_LOCALES) {
    const copy = translate("dashboard.calibration.noRate", {}, locale);
    assert.match(copy, new RegExp(String(contractPointMinimum), "u"), locale);
    assert.match(copy, new RegExp(String(contractSpanMinimum), "u"), locale);
  }

  const hostedCopy = translate("dashboard.unavailable.companionCopy");
  assert.match(hostedCopy, /Applications/u);
  assert.match(hostedCopy, /installer/u);

  const inAppCopy = translate("dashboard.unavailable.companionInAppCopy");
  assert.match(inAppCopy, /Refresh/u);
  assert.match(inAppCopy, /quit and reopen/u);
  assert.match(inAppCopy, /contact Support/u);
  assert.doesNotMatch(inAppCopy, /Applications|installer|install/u);
});

test("shared per-model rate copy states the kernel's own share floor", async () => {
  // The card tells the reader the exact share below which a model gets no rate
  // of its own. That number is the composition kernel's, mirrored into the
  // browser catalog because it cannot import the kernel; a silent drift would
  // print a threshold the fit does not use.
  assert.equal(
    COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT / 100,
    MODEL_COMPOSITION_POLICY.minimumModelCostShare,
  );

  for (const locale of SUPPORTED_LOCALES) {
    const copy = translate(
      "dashboard.calibration.perModelSharedExplainer",
      { threshold: `${COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT}%` },
      locale,
    );
    assert.match(
      copy,
      new RegExp(`${COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT}%`, "u"),
      locale,
    );
    assert.doesNotMatch(copy, /\{threshold\}/u, locale);
  }

  // A model the fit could not price is named with its share, never with a
  // borrowed figure.
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "dashboard.calibration.perModelShared",
      "dashboard.calibration.perModelNoRate",
    ]) {
      const copy = translate(key, { share: "0.2%" }, locale);
      assert.match(copy, /0\.2%/u, `${key} ${locale}`);
      assert.doesNotMatch(copy, /\{share\}/u, `${key} ${locale}`);
    }
    assert.equal(
      translate("dashboard.calibration.perModelRateUnavailable", {}, locale)
        .trim().length > 0,
      true,
      locale,
    );
  }
});

test("accounting period history labels preserve three-locale parity", () => {
  const labels = [
    [
      "accounting.period.indexedHistory",
      ["Indexed history", "已索引历史", "Historial indexado"],
    ],
    [
      "accounting.period.indexedHistorySoFar",
      ["Indexed history so far", "目前已索引的历史", "Historial indexado hasta ahora"],
    ],
  ];

  for (const [key, expected] of labels) {
    assert.deepEqual(
      SUPPORTED_LOCALES.map((locale) => translate(key, {}, locale)),
      expected,
      key,
    );
  }
});

test("Keychain migration recovery names the real native controls in every locale", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const copies = [
    "identity_migration_required",
    "contribution_device_keychain_migration_required",
  ].map((code) => {
    const copy = appSource.match(new RegExp(`${code}:\\n\\s*"([^"]+)"`, "u"))?.[1];
    assert.ok(copy, `${code} has fixed recovery copy`);
    return copy;
  });
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const migrationNotice = html.match(
    /id="incremental-keychain-migration-note" hidden>([\s\S]*?)<\/p>/u,
  )?.[1].replace(/\s+/gu, " ").trim();
  assert.ok(migrationNotice, "static migration notice is present");
  assert.match(migrationNotice, /first tries .* silently/u);
  assert.match(migrationNotice, /without changing its value or uploading anything/u);
  assert.match(migrationNotice, /Settings… → General/u);
  assert.match(migrationNotice, /Review migration…/u);
  assert.match(migrationNotice, /credential and local history stay unchanged/u);
  assert.doesNotMatch(migrationNotice, /macOS asks|Always Allow|quit and reopen/u);
  for (const [locale, resourceLocale] of [
    ["en-US", "en"],
    ["zh-Hans", "zh-Hans"],
    ["es", "es"],
  ]) {
    const nativeCatalog = await readFile(new URL(
      `../../macos/Resources/${resourceLocale}.lproj/Localizable.strings`,
      import.meta.url,
    ), "utf8");
    const nativeLabels = new Map([...nativeCatalog.matchAll(/^"([^"]+)" = "([^"]+)";$/gmu)]
      .map(([, key, value]) => [key, value]));
    for (const english of copies) {
      const translated = translateLegacyText(english, locale);
      for (const key of [
        "menu.settings",
        "settings.general",
        "settings.keychainMigrationTitle",
        "settings.keychainMigrationReview",
      ]) {
        const nativeLabel = nativeLabels.get(key);
        assert.ok(nativeLabel, `${locale} native ${key} exists`);
        assert.equal(translated.includes(nativeLabel), true, `${locale} names ${key}`);
      }
      if (locale !== "en-US") assert.notEqual(translated, english, locale);
    }
    const translatedNotice = translateLegacyText(migrationNotice, locale);
    for (const key of [
      "menu.settings",
      "settings.general",
      "settings.keychainMigrationTitle",
      "settings.keychainMigrationReview",
    ]) {
      assert.equal(
        translatedNotice.includes(nativeLabels.get(key)),
        true,
        `${locale} notice names ${key}`,
      );
    }
    if (locale !== "en-US") assert.notEqual(translatedNotice, migrationNotice, locale);
  }
});

test("Keychain connection and denied-access copy never recommends approval prompts or credential clearing", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const denied = appSource.match(/contribution_device_keychain_access_denied:\n\s*"([^"]+)"/u)?.[1];
  const pairing = appSource.match(/device_pairing: Object\.freeze\(\{[\s\S]*?progress: "([^"]+)"/u)?.[1];
  const note = html.match(/id="incremental-keychain-pairing-note">([\s\S]*?)<\/p>/u)?.[1]
    .replace(/\s+/gu, " ").trim();
  assert.ok(denied);
  assert.ok(pairing);
  assert.ok(note);
  assert.match(denied, /Uploads are paused/u);
  assert.match(denied, /credential and local history are unchanged/u);
  assert.match(denied, /Nothing was uploaded/u);
  const forbiddenAdvice = /Always Allow|Permitir siempre|始终允许|password|contraseña|密码|Clear .*credential|borra.*credencial|清除.*凭据/iu;
  for (const locale of SUPPORTED_LOCALES) {
    for (const copy of [denied, pairing, note]) {
      const translated = translateLegacyText(copy, locale);
      assert.equal(typeof translated, "string");
      assert.notEqual(translated.trim(), "");
      assert.doesNotMatch(translated, forbiddenAdvice, `${locale} ${copy}`);
      if (locale !== "en-US") assert.notEqual(translated, copy, `${locale} has its own translation`);
    }
  }
  assert.deepEqual(SUPPORTED_LOCALES.map((locale) => translateLegacyText(denied, locale)), [
    "Uploads are paused because TiboTattle could not access this Mac's upload credential. The existing credential and local history are unchanged. Nothing was uploaded. You can try again later.",
    "TiboTattle 无法访问这台 Mac 的上传凭据，因此上传已暂停。现有凭据和本地历史记录均未改变。没有上传任何内容。你可以稍后重试。",
    "Las cargas están en pausa porque TiboTattle no pudo acceder a la credencial de carga de este Mac. La credencial existente y el historial local no han cambiado. No se ha subido nada. Puedes volver a intentarlo más tarde.",
  ]);
  const blanketApproval = /Always Allow|Permitir siempre|始终允许/iu;
  assert.doesNotMatch(appSource, blanketApproval);
  assert.doesNotMatch(html, blanketApproval);
  for (const [english, translations] of Object.entries(LEGACY_TEXT_CATALOG)) {
    for (const copy of [english, ...translations]) assert.doesNotMatch(copy, blanketApproval);
  }
});
