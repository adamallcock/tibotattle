import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CATALOGS,
  DEFAULT_LOCALE,
  EN_US_CATALOG,
  ES_CATALOG,
  SUPPORTED_LOCALES,
  ZH_HANS_CATALOG,
  formatDate,
  formatNumber,
  formatPercent,
  getMessage,
  interpolateMessage,
  negotiateLocale,
  resolveLocalePreference,
  translate,
} from "../packages/i18n/index.js";

test("i18n is a dependency-free workspace package with complete initial catalogs", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../packages/i18n/package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.name, "@app-usagemonitor/i18n");
  assert.deepEqual(manifest.exports["."], {
    types: "./index.d.ts",
    import: "./index.js",
    default: "./index.js",
  });
  assert.deepEqual(manifest.files, ["index.d.ts", "index.js"]);
  assert.equal(Object.hasOwn(manifest, "dependencies"), false);
  assert.equal(DEFAULT_LOCALE, "en-US");
  assert.deepEqual(SUPPORTED_LOCALES, ["en-US", "zh-Hans", "es"]);
  assert.equal(CATALOGS[DEFAULT_LOCALE], EN_US_CATALOG);
  assert.equal(CATALOGS["zh-Hans"], ZH_HANS_CATALOG);
  assert.equal(CATALOGS.es, ES_CATALOG);
  assert.equal(EN_US_CATALOG["app.name"], "TiboTattle");
  const keys = Object.keys(EN_US_CATALOG).sort();
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, `${locale} key parity`);
    assert.equal(
      Object.values(catalog).every((value) => value.trim().length > 0),
      true,
      `${locale} contains no blank catalog value`,
    );
  }
});

test("locale negotiation prefers exact and language matches before fallback", () => {
  assert.equal(negotiateLocale("en-US"), "en-US");
  assert.equal(negotiateLocale("EN-us"), "en-US");
  assert.equal(negotiateLocale("en"), "en-US");
  assert.equal(negotiateLocale("zh-CN"), "zh-Hans");
  assert.equal(negotiateLocale("zh-SG"), "zh-Hans");
  assert.equal(negotiateLocale("zh-TW"), "en-US");
  assert.equal(negotiateLocale("zh-Hant"), "en-US");
  assert.equal(negotiateLocale("es-MX"), "es");
  assert.equal(negotiateLocale(["fr-FR", "en-US"]), "en-US");
  assert.equal(negotiateLocale("fr-FR"), "en-US");
  assert.equal(
    negotiateLocale(null, ["en-US", "de-DE"], "de-DE"),
    "de-DE",
  );
  assert.equal(
    negotiateLocale("de-AT", ["en-US", "de-DE"], "en-US"),
    "de-DE",
  );
  assert.equal(
    negotiateLocale(["invalid_locale", "de-DE"], ["en-US", "de-DE"]),
    "de-DE",
  );
  assert.throws(
    () => negotiateLocale("en-US", ["invalid_locale"]),
    RangeError,
  );
  assert.equal(resolveLocalePreference("system", ["es-MX"]), "es");
  assert.equal(resolveLocalePreference("zh-Hans", ["es-MX"]), "zh-Hans");
});

test("message lookup and interpolation keep missing content visible", () => {
  assert.equal(
    getMessage(EN_US_CATALOG, "usage.events"),
    "Usage events: {count}",
  );
  assert.equal(
    translate("usage.events", { count: 12 }, { locale: "zh-Hans" }),
    "使用事件：12",
  );
  assert.equal(
    translate("usage.events", { count: 12 }, { locale: "es" }),
    "Eventos de uso: 12",
  );
  assert.equal(
    getMessage(EN_US_CATALOG, "missing.key"),
    "missing.key",
  );
  assert.equal(
    getMessage(EN_US_CATALOG, "missing.key", "Not translated"),
    "Not translated",
  );
  assert.equal(
    interpolateMessage("{count} events for {{owner}}", {
      count: 0,
      owner: "Adam",
    }),
    "0 events for Adam",
  );
  assert.equal(
    interpolateMessage("Missing {value}; null {empty}", {
      empty: null,
    }),
    "Missing {value}; null {empty}",
  );

  const catalogs = {
    "en-US": EN_US_CATALOG,
    "fr-FR": Object.freeze({ "usage.events": "Événements : {count}" }),
  };
  assert.equal(
    translate("usage.events", { count: 12 }, { locale: "fr-FR", catalogs }),
    "Événements : 12",
  );
  assert.equal(
    translate("app.name", {}, { locale: "fr-FR", catalogs }),
    "TiboTattle",
  );
  assert.equal(
    translate("missing.key", {}, { locale: "fr-FR", catalogs }),
    "missing.key",
  );
});

test("number and date formatting uses Intl locale conventions and safe defaults", () => {
  assert.equal(formatNumber(1234567.89, "en-US"), "1,234,567.89");
  assert.equal(formatNumber(1234567.89, "de-DE"), "1.234.567,89");
  assert.equal(
    formatNumber(12.5, "en-US", { style: "currency", currency: "USD" }),
    "$12.50",
  );
  assert.equal(formatNumber(1234.5, "invalid_locale"), "1,234.5");
  assert.equal(formatPercent(0.125, "en-US"), "13%");
  assert.match(formatPercent(0.125, "es"), /13/u);

  const instant = new Date("2026-01-02T15:04:05.000Z");
  assert.equal(formatDate(instant, "en-US"), "Jan 2, 2026");
  assert.equal(formatDate(instant, "de-DE"), "02.01.2026");
  assert.equal(formatDate(instant, "invalid_locale"), "Jan 2, 2026");
  assert.throws(() => formatDate("not-a-date", "en-US"), RangeError);
});
