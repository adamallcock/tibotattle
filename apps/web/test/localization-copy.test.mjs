import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SUPPORTED_LOCALES,
  WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP,
  WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES,
  translate,
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
