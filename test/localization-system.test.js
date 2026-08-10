import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  LEGACY_TEXT_CATALOG,
  LOCALIZATION_SCHEMA_VERSION,
  SUPPORTED_LOCALES,
  WEB_MESSAGES,
  WEB_PLURAL_MESSAGES,
  createBrowserLocalization,
  directionForLocale,
  negotiateLocale,
  pseudoLocalize,
  translate,
  translatePlural,
  translateLegacyText,
} from "../apps/web/public/localization.js";

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu)]
    .map(([, key]) => key)
    .sort();
}

function normalizedHtmlText(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function staticHtmlTextNodes(html) {
  const withoutNonVisibleSource = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<script\b[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[\s\S]*?<\/style>/giu, "");
  return [...withoutNonVisibleSource.matchAll(/>([^<]+)</gu)]
    .map(([, value]) => normalizedHtmlText(value))
    .filter(Boolean);
}

function directTextLiterals(source) {
  return [...source.matchAll(
    /\.textContent\s*=\s*(["'])([^\n]*?)\1/gu,
  )]
    .map(([, , value]) => value)
    .filter((value) => /[A-Za-z]{3}/u.test(value));
}

function hasEnglishCatalogValue(value) {
  return Object.hasOwn(LEGACY_TEXT_CATALOG, value)
    || Object.values(WEB_MESSAGES).some(([english]) => english === value);
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function fakeWindow({ host = null, languages = ["en-US"], storage = null } = {}) {
  const listeners = new Map();
  const events = [];
  return {
    __TIBOTATTLE_LOCALIZATION__: host,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
    events,
    listeners,
    localStorage: storage,
    navigator: { languages },
  };
}

test("browser catalogs preserve placeholders, plural forms, and legacy text has both initial translations", () => {
  assert.deepEqual(SUPPORTED_LOCALES, ["en-US", "zh-Hans", "es"]);
  for (const [key, values] of Object.entries(WEB_MESSAGES)) {
    assert.equal(values.length, 3, `${key} has an entry per supported locale`);
    assert.equal(values.every((value) => value.trim().length > 0), true, key);
    assert.deepEqual(placeholders(values[1]), placeholders(values[0]), key);
    assert.deepEqual(placeholders(values[2]), placeholders(values[0]), key);
  }
  for (const [english, values] of Object.entries(LEGACY_TEXT_CATALOG)) {
    assert.equal(english.trim().length > 0, true);
    assert.equal(values.length, 2, `${english} has zh-Hans and es values`);
    assert.equal(values.every((value) => value.trim().length > 0), true, english);
  }
  for (const [key, forms] of Object.entries(WEB_PLURAL_MESSAGES)) {
    assert.equal(Object.hasOwn(forms, "other"), true, `${key} has a fallback plural form`);
    for (const [category, values] of Object.entries(forms)) {
      assert.equal(values.length, 3, `${key}.${category} has an entry per locale`);
      assert.equal(values.every((value) => value.trim().length > 0), true, `${key}.${category}`);
      assert.deepEqual(placeholders(values[1]), placeholders(values[0]), `${key}.${category}`);
      assert.deepEqual(placeholders(values[2]), placeholders(values[0]), `${key}.${category}`);
    }
  }
  assert.equal(
    translate("installer.sha256", { value: "<untrusted>" }, "zh-Hans"),
    "SHA-256 <untrusted>",
  );
  assert.equal(
    translate("dashboard.unavailable.companionTitle", {}, "es"),
    "El acompañante local no está disponible",
  );
  assert.equal(
    translateLegacyText("Starting local analysis…", "zh-Hans"),
    "正在开始本地分析…",
  );
  assert.equal(
    translatePlural("dashboard.timeline.window", 1, {}, "en-US"),
    "1 matched quota window",
  );
  assert.equal(
    translatePlural("dashboard.timeline.window", 2, {}, "es"),
    "2 ventanas de cuota coincidentes",
  );
  assert.equal(
    translatePlural("contribution.batch", 3, {}, "zh-Hans"),
    "3 个贡献批次",
  );
  assert.equal(
    translatePlural("contribution.batch", Number.NaN, {}, "en-US"),
    "0 contribution batches",
  );
  assert.equal(
    translatePlural("quota.durationDay", 30, {}, "es"),
    "30 días",
  );
  assert.equal(
    translate(
      "dashboard.quota.windowProviderReported",
      { duration: translatePlural("quota.durationDay", 30, {}, "zh-Hans") },
      "zh-Hans",
    ),
    "提供方报告的 30 天 窗口",
  );
  const pseudo = pseudoLocalize("Version {version} is available");
  assert.match(pseudo, /^［.+］$/u);
  assert.match(pseudo, /\{version\}/u, "pseudo-localization preserves placeholders");
  assert.ok(pseudo.length > "Version {version} is available".length);
});

test("shipped static web copy has a complete translated inventory and localizable accessibility labels", async () => {
  const staticPages = ["index.html", "community.html"];
  const sourceFiles = await Promise.all(staticPages.map((file) => readFile(
    new URL(`../apps/web/public/${file}`, import.meta.url),
    "utf8",
  )));
  const copyThatNeedsNoTranslation = new Set(["TiboTattle"]);
  const neutralGlyph = /^[+＋−—⇢→←\d\s.]+$/u;

  for (const [index, source] of sourceFiles.entries()) {
    assert.match(source, /<body\b[^>]*\bdata-i18n-root\b/u, staticPages[index]);
    assert.match(source, /\bdata-i18n-legacy-root\b/u, staticPages[index]);
    assert.match(
      source,
      /data-language-announcement[^>]*aria-live="polite"/u,
      `${staticPages[index]} announces a language change to assistive technology`,
    );
    for (const text of new Set(staticHtmlTextNodes(source))) {
      if (copyThatNeedsNoTranslation.has(text) || neutralGlyph.test(text)) continue;
      if (text === "Language") {
        assert.match(source, /data-i18n="language\.label"/u, staticPages[index]);
        continue;
      }
      assert.equal(
        Object.hasOwn(LEGACY_TEXT_CATALOG, text),
        true,
        `${staticPages[index]} is missing a zh-Hans/es legacy translation for ${JSON.stringify(text)}`,
      );
    }

    for (const [, key] of source.matchAll(
      /data-i18n(?:-(?:aria-label|title|placeholder))?="([^"]+)"/gu,
    )) {
      assert.equal(
        Object.hasOwn(WEB_MESSAGES, key),
        true,
        `${staticPages[index]} references a missing semantic localization key ${key}`,
      );
    }
  }

  const css = await readFile(
    new URL("../apps/web/public/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /border-inline-start/u);
  assert.match(css, /padding-inline/u);
  assert.doesNotMatch(css, /\b(?:margin|padding|border)-(?:left|right)\b/u);
  assert.doesNotMatch(css, /\btext-align:\s*(?:left|right)\b/u);
});

test("locale negotiation is safe for Chinese scripts, fallback, and RTL direction", () => {
  assert.equal(negotiateLocale(["zh-TW", "es-MX"]), "es");
  assert.equal(negotiateLocale("zh-TW"), DEFAULT_LOCALE);
  assert.equal(negotiateLocale("zh-CN"), "zh-Hans");
  assert.equal(negotiateLocale("zh-SG"), "zh-Hans");
  assert.equal(negotiateLocale("zh-Hant"), DEFAULT_LOCALE);
  assert.equal(negotiateLocale("unsupported"), DEFAULT_LOCALE);
  assert.equal(directionForLocale("ar-EG"), "rtl");
  assert.equal(directionForLocale("he"), "rtl");
  assert.equal(directionForLocale("zh-Hans"), "ltr");
});

test("literal generated browser text stays in the translation inventory", async () => {
  const sourceFiles = [
    "app.js",
    "community.js",
    "community-view.js",
    "install-cta.js",
    "ui-format.js",
  ];
  const sources = await Promise.all(sourceFiles.map((file) => readFile(
    new URL(`../apps/web/public/${file}`, import.meta.url),
    "utf8",
  )));
  for (const [index, source] of sources.entries()) {
    for (const value of directTextLiterals(source)) {
      assert.equal(
        hasEnglishCatalogValue(value),
        true,
        `${sourceFiles[index]} direct user-facing literal lacks a catalog entry: ${JSON.stringify(value)}`,
      );
    }
    for (const [, key] of source.matchAll(
      /\b(?:t|translate|translateMessage)\(\s*["']([A-Za-z][A-Za-z0-9_.-]*)["']/gu,
    )) {
      assert.equal(
        Object.hasOwn(WEB_MESSAGES, key),
        true,
        `${sourceFiles[index]} references a missing semantic key ${key}`,
      );
    }
    for (const [, key] of source.matchAll(
      /\btPlural\(\s*["']([A-Za-z][A-Za-z0-9_.-]*)["']/gu,
    )) {
      assert.equal(
        Object.hasOwn(WEB_PLURAL_MESSAGES, key),
        true,
        `${sourceFiles[index]} references a missing plural key ${key}`,
      );
    }
  }
});

test("browser override persists while native override is message-validated and does not reload", () => {
  const storage = memoryStorage();
  const browserWindow = fakeWindow({ languages: ["es-MX"], storage });
  const browser = createBrowserLocalization({
    windowRef: browserWindow,
    documentRef: null,
  });
  assert.equal(browser.locale(), "es");
  browser.setLanguagePreference("zh-Hans");
  assert.equal(browser.preference(), "zh-Hans");
  assert.equal(browser.locale(), "zh-Hans");
  assert.equal(storage.getItem("tibotattle.language-preference.v1"), "zh-Hans");
  assert.equal(browserWindow.events.at(-1).type, "tibotattle:locale-change");

  const messages = [];
  const nativeWindow = fakeWindow({
    host: {
      schemaVersion: LOCALIZATION_SCHEMA_VERSION,
      host: "native",
      languagePreference: "system",
      preferredLanguages: ["zh-TW"],
      formatLocale: "fr-FR",
    },
    languages: ["es-MX"],
  });
  nativeWindow.webkit = {
    messageHandlers: {
      tibotattleLocalization: {
        postMessage(value) {
          messages.push(value);
        },
      },
    },
  };
  const native = createBrowserLocalization({
    windowRef: nativeWindow,
    documentRef: null,
  });
  assert.equal(native.locale(), "en-US", "Traditional Chinese is not guessed as Hans");
  assert.equal(native.formatLocale(), "fr-FR", "formatting remains regional");
  native.setLanguagePreference("es");
  assert.equal(native.locale(), "es");
  assert.deepEqual(messages, [{ type: "set-language-preference", preference: "es" }]);
  nativeWindow.listeners.get("tibotattle:locale-override")({
    detail: { preference: "zh-Hans" },
  });
  assert.equal(native.locale(), "zh-Hans");
  assert.equal(messages.length, 1, "host event does not echo back into a loop");
});

test("localizer is root-bounded, preserves raw-data boundaries, and never interpolates HTML", async () => {
  const [source, appSource] = await Promise.all([
    readFile(
    new URL("../apps/web/public/localization.js", import.meta.url),
    "utf8",
    ),
    readFile(new URL("../apps/web/public/app.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(source, /\.innerHTML\s*=/u);
  assert.match(source, /\[data-i18n-root\]/u);
  assert.match(source, /\[data-i18n-legacy-root\]/u);
  assert.match(source, /\[data-i18n-skip\]/u);
  assert.match(source, /const staticLegacyTextNodes = new Set\(\)/u);
  assert.match(source, /const ownedLegacyText = new Map\(\)/u);
  assert.match(source, /new Intl\.PluralRules\(resolvedLocale\)/u);
  assert.match(source, /node\.nodeValue = next/u);
  assert.match(source, /element\.textContent = value/u);
  assert.doesNotMatch(appSource, /\.innerHTML\s*=/u);
  assert.match(appSource, /function setRawText\(/u);
  assert.match(appSource, /function rawNode\(/u);
  assert.match(appSource, /setRawText\(\$\("#identity-account-provider"\)/u);
  assert.match(
    appSource,
    /node\("span", "metric-name", localizedQuotaWindowLabel\(window\)\)/u,
  );
  // The SVG <title>/<desc> pair used to be asserted as `setRawText(titleNode,
  // title)` — an assertion that the chart's accessible name was whatever raw
  // string the caller passed, which is exactly the gap that let hardcoded
  // English into the one text layer the localization bridge cannot see. It is
  // removed rather than inverted: pinning that call's argument list in a
  // regex is the wrong instrument for "chart text is localized". The
  // behavioural cover lives in apps/web/test/lib.test.mjs, where lineChart is
  // rendered with a fake document and its SVG text is read back.
  // Re-pinned 2026-08-08: native SVG <title> markers were removed outright
  // (they produced a duplicate grey tooltip beside the styled hover, owner
  // report). Marker accessibility is aria-label based now and behaviourally
  // covered in apps/web/test/lib.test.mjs.
  assert.doesNotMatch(appSource, /setRawText\(markerTitle, caption\)/u);
  assert.match(appSource, /function renderDashboardUnavailableState\(/u);
  assert.match(appSource, /setLocalizedText\(\$\("#data-source"\), "dashboard\.unavailable\.noRealUsage"\)/u);
  assert.doesNotMatch(appSource, /translateText\("Range unavailable"\)/u);
});
