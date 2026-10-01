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

test("every explicit dashboard translation key resolves through the browser catalog", async () => {
  const markup = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const keys = new Set([...markup.matchAll(/data-i18n(?:-(?:aria-label|alt|title|placeholder))?="([^"]+)"/gu)]
    .map(match => match[1]));
  assert.ok(keys.size > 0);
  for (const key of keys) {
    for (const locale of SUPPORTED_LOCALES) {
      const copy = translate(key, {}, locale);
      assert.ok(copy.trim().length > 0, `${locale}: ${key}`);
      assert.notEqual(copy, key, `${locale}: ${key} must not leak into the rendered dashboard`);
    }
  }
});

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

test("dashboard and translation copy never recommends blanket Keychain approval", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const blanketApproval = /Always Allow|Permitir siempre|始终允许/iu;
  assert.doesNotMatch(appSource, blanketApproval);
  assert.doesNotMatch(html, blanketApproval);
  for (const [english, translations] of Object.entries(LEGACY_TEXT_CATALOG)) {
    for (const copy of [english, ...translations]) assert.doesNotMatch(copy, blanketApproval);
  }
});
