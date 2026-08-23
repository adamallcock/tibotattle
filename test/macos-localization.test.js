import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectMacOSLocalizationResources,
  stageMacOSLocalizationResources,
} from "../scripts/build-macos-app.js";

const REPOSITORY_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/u, "");
const RESOURCE_ROOT = join(REPOSITORY_ROOT, "apps", "macos", "Resources");
const LOCALIZATION_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Sources",
  "Localization.swift",
);
const APP_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "UsageMonitorApp.swift",
);
const MENU_BAR_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Sources",
  "MenuBarStatus.swift",
);
const NATIVE_RESOURCE_LOCALES = ["en", "es", "zh-Hans"];

function parseStrings(source) {
  const entries = new Map();
  for (const match of source.matchAll(/^"((?:[^"\\]|\\.)+)"\s*=\s*"((?:[^"\\]|\\.)*)";$/gmu)) {
    const key = match[1].replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    const value = match[2].replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    assert.equal(entries.has(key), false, `duplicate localization key ${key}`);
    entries.set(key, value);
  }
  return entries;
}

function swiftLocalizationKeys(source) {
  const keyEnum = source.match(
    /enum Key: String, CaseIterable \{([\s\S]*?)\n    \}/u,
  )?.[1];
  assert.ok(keyEnum, "TiboTattleLocalization.Key must remain a closed inventory");
  return [...keyEnum.matchAll(/case \w+ = "([^"]+)"/gu)].map(
    ([, key]) => key,
  );
}

function placeholderSignature(value) {
  return [...value.matchAll(/%(?:\d+\$)?(?:@|d|D|i|u|f|g|s)/gu)]
    .map(([token]) => token.replace(/%\d+\$/u, "%"))
    .sort();
}

test("native catalogs have complete language parity and preserve placeholders", async () => {
  const [manifestText, swiftSource, appSource, menuBarSource, ...catalogTexts] = await Promise.all([
    readFile(join(RESOURCE_ROOT, "localization", "manifest.json"), "utf8"),
    readFile(LOCALIZATION_SOURCE, "utf8"),
    readFile(APP_SOURCE, "utf8"),
    readFile(MENU_BAR_SOURCE, "utf8"),
    ...NATIVE_RESOURCE_LOCALES.map((locale) => readFile(
      join(RESOURCE_ROOT, `${locale}.lproj`, "Localizable.strings"),
      "utf8",
    )),
  ]);
  const manifest = JSON.parse(manifestText);
  const keys = swiftLocalizationKeys(swiftSource).sort();
  const catalogs = new Map(NATIVE_RESOURCE_LOCALES.map((locale, index) => [
    locale,
    parseStrings(catalogTexts[index]),
  ]));

  assert.deepEqual(manifest, {
    schemaVersion: "tibotattle-localization-v2",
    table: "Localizable",
    fallbackLocale: "en-US",
    defaultLocale: "en-US",
    supportedLocales: ["en-US", "zh-Hans", "es"],
    preference: "system-or-user-override",
    webResourceRoot: "./localization",
  });
  for (const [locale, catalog] of catalogs) {
    assert.deepEqual([...catalog.keys()].sort(), keys, `${locale} key parity`);
    assert.equal(
      [...catalog.values()].every((value) => value.trim().length > 0),
      true,
      `${locale} contains no blank translation`,
    );
  }
  const english = catalogs.get("en");
  for (const locale of ["zh-Hans", "es"]) {
    const catalog = catalogs.get(locale);
    for (const key of keys) {
      assert.deepEqual(
        placeholderSignature(catalog.get(key)),
        placeholderSignature(english.get(key)),
        `${locale} preserves placeholders for ${key}`,
      );
    }
  }
  assert.equal(english.get("settings.language"), "Language");
  assert.equal(
    english.get("settings.languageSummary"),
    "Uses your Mac language by default.",
  );
  assert.equal(
    english.get("settings.updateCheckUnavailableTitle"),
    "Couldn't check for updates",
  );
  assert.equal(
    english.get("settings.updateCheckUnavailableMessage"),
    "TiboTattle couldn't complete the update check. Check your internet connection and try again.",
  );
  assert.equal(
    english.get("launcher.dashboardTakingLonger"),
    "Dashboard is taking longer than expected",
  );
  assert.equal(
    english.get("launcher.errorDashboardReadinessTimeout"),
    "The local dashboard page loaded, but it did not become ready during the initial wait.",
  );
  assert.equal(
    english.get("launcher.recoveryDashboardWebView"),
    "Choose Open Dashboard to try the local view again. If it still does not open, choose Retry.",
  );
  assert.equal(
    catalogs.get("es").get("launcher.recoveryDashboardWebView"),
    "Elige Abrir panel para volver a intentar la vista local. Si aún no se abre, elige Reintentar.",
  );
  assert.equal(
    catalogs.get("zh-Hans").get("launcher.recoveryDashboardWebView"),
    "请选择“打开仪表板”再次尝试本地视图。如果仍无法打开，请选择“重试”。",
  );
  assert.match(swiftSource, /LanguagePreference: String, CaseIterable/u);
  assert.match(swiftSource, /UserDefaults\.standard\.set/u);
  assert.match(swiftSource, /Locale\.preferredLanguages/u);
  assert.match(swiftSource, /static var locale: Locale \{\s*\.current/u);
  assert.match(swiftSource, /fallbackLocalization = "en"/u);
  assert.match(appSource, /window\.__TIBOTATTLE_LOCALIZATION__/u);
  assert.match(appSource, /"host": "native"/u);
  assert.match(appSource, /"supportedLocales": TiboTattleLocalization\.supportedWebLocales/u);
  assert.match(appSource, /"formatLocale": Locale\.current\.identifier/u);
  assert.match(appSource, /WKScriptMessageHandler/u);
  assert.match(appSource, /name: "tibotattleLocalization"/u);
  assert.match(appSource, /notifyLanguagePreferenceChange/u);
  assert.match(appSource, /notifyHostedSignInReturn[\s\S]*?tibotattle:hosted-sign-in-return/u);
  assert.match(
    appSource,
    /private static func addDocumentStartScripts[\s\S]*?source: localizationHandoffScript\(\),[\s\S]*?injectionTime: \.atDocumentStart/u,
  );
  assert.match(
    appSource,
    /private func refreshDocumentStartScripts\(\)[\s\S]*?removeAllUserScripts\(\)[\s\S]*?addDocumentStartScripts\(to: controller\)/u,
  );
  assert.match(
    appSource,
    /request\.cachePolicy = \.reloadIgnoringLocalCacheData[\s\S]*?refreshDocumentStartScripts\(\)[\s\S]*?webView\.load\(request\)/u,
  );
  const languageNotification = appSource.match(
    /func notifyLanguagePreferenceChange\([\s\S]*?\n    \}/u,
  )?.[0] ?? "";
  assert.match(languageNotification, /tibotattle:locale-override/u);
  assert.match(languageNotification, /requestAnimationFrame/u);
  assert.doesNotMatch(languageNotification, /webView\.load\(/u);
  assert.match(appSource, /nativeDashboardChrome\?\.refreshLocalization\(\)/u);
  assert.match(appSource, /refreshNativeToolbarLocalization\(\)/u);
  assert.match(appSource, /settingsWindow\?\.close\(\)/u);
  assert.match(swiftSource, /case nativeDashboardFresh =/u);
  assert.match(swiftSource, /case nativeDashboardNeedsRefresh =/u);
  assert.match(appSource, /settingsUpdateDisclosureDevelopment/u);
  assert.match(appSource, /launcherErrorInvalidCentralService/u);
  assert.match(appSource, /launcherRecoveryReinstall/u);
  assert.match(appSource, /nativeDashboardCurrentEvidenceTooltip/u);
  assert.match(appSource, /settingsCodexFolderCustomSelected/u);
  assert.match(appSource, /settingsRefreshInterval/u);
  assert.match(appSource, /static let defaultsKey = "tibotattle\.refresh-interval\.v1"/u);
  assert.match(appSource, /allowedSeconds = \[60, 5 \* 60, 15 \* 60, 30 \* 60\]/u);
  assert.match(appSource, /settingsOpenNotifications/u);
  assert.match(appSource, /com\.apple\.Notifications-Settings\.extension/u);
  assert.doesNotMatch(appSource, /settingsNotificationsReset\)/u);
  assert.doesNotMatch(appSource, /toggleQuotaNotificationReset/u);
  assert.match(
    swiftSource,
    /Local usage refreshes while TiboTattle is open\. Raw logs stay on this Mac\./iu,
  );
  assert.match(
    swiftSource,
    /Start TiboTattle when you sign in\. Manage this in System Settings → Login Items\./iu,
  );
  assert.match(swiftSource, /System Settings → Login Items/u);
  assert.match(menuBarSource, /menuBarAnalysisRequestRejected/u);
  assert.match(menuBarSource, /accessibilityMenuBarStatus/u);
  assert.doesNotMatch(
    menuBarSource,
    /"The local companion could not accept an analysis request\."/u,
  );
});

test("localization resources stage for AppKit and the embedded dashboard", async () => {
  const resources = await collectMacOSLocalizationResources();
  assert.deepEqual(resources.relativeFiles, [
    "en.lproj/Localizable.strings",
    "es.lproj/Localizable.strings",
    "localization/manifest.json",
    "zh-Hans.lproj/Localizable.strings",
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "tibotattle-localization-"));
  try {
    const contents = join(temporaryRoot, "Contents");
    const appRoot = join(contents, "Resources", "app");
    const staged = await stageMacOSLocalizationResources(contents, appRoot, resources);
    assert.deepEqual(staged.map(({ relativeFile, webRelativeFile }) => ({
      relativeFile,
      webRelativeFile,
    })), [
      {
        relativeFile: "en.lproj/Localizable.strings",
        webRelativeFile: "localization/en.lproj/Localizable.strings",
      },
      {
        relativeFile: "es.lproj/Localizable.strings",
        webRelativeFile: "localization/es.lproj/Localizable.strings",
      },
      {
        relativeFile: "localization/manifest.json",
        webRelativeFile: "localization/manifest.json",
      },
      {
        relativeFile: "zh-Hans.lproj/Localizable.strings",
        webRelativeFile: "localization/zh-Hans.lproj/Localizable.strings",
      },
    ]);
    for (const relativeFile of resources.relativeFiles) {
      const native = await readFile(join(contents, "Resources", relativeFile));
      const webRelativeFile = relativeFile.startsWith("localization/")
        ? relativeFile
        : join("localization", relativeFile);
      const web = await readFile(join(appRoot, webRelativeFile));
      assert.deepEqual(web, native, relativeFile);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
