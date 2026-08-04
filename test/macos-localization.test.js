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

test("localization catalog is complete, English-backed, and system-default", async () => {
  const [manifestText, stringsText, swiftSource, appSource] = await Promise.all([
    readFile(join(RESOURCE_ROOT, "localization", "manifest.json"), "utf8"),
    readFile(join(RESOURCE_ROOT, "en.lproj", "Localizable.strings"), "utf8"),
    readFile(LOCALIZATION_SOURCE, "utf8"),
    readFile(APP_SOURCE, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const strings = parseStrings(stringsText);
  const keys = [...swiftSource.matchAll(/case \w+ = "([^"]+)"/gu)].map(
    ([, key]) => key,
  );
  assert.deepEqual(manifest, {
    schemaVersion: "tibotattle-localization-v1",
    table: "Localizable",
    fallbackLocale: "en",
    defaultLocale: "en",
    supportedLocales: ["en"],
    preference: "system",
    webResourceRoot: "./localization",
  });
  assert.deepEqual([...strings.keys()].sort(), [...keys].sort());
  assert.equal([...strings.values()].every((value) => value.length > 0), true);
  assert.equal(strings.get("settings.language"), "Language");
  assert.equal(
    strings.get("settings.languageSummary"),
    "Uses the Mac language when available; regional formats follow this Mac.",
  );
  assert.equal(strings.get("settings.languageSystem"), "System");
  assert.match(swiftSource, /Locale\.preferredLanguages/u);
  assert.match(swiftSource, /static var locale: Locale \{\s*\.current/u);
  assert.match(swiftSource, /fallbackLocalization = "en"/u);
  assert.match(appSource, /window\.__TIBOTATTLE_LOCALIZATION__/u);
  assert.match(appSource, /"preferredLanguages": Locale\.preferredLanguages/u);
  assert.match(appSource, /"resourceRoot": "\.\/localization"/u);
  assert.match(
    appSource,
    /let localizationHandoff = Self\.localizationHandoffScript\(\)[\s\S]*?source: localizationHandoff,[\s\S]*?injectionTime: \.atDocumentStart/u,
  );
});

test("localization resources stage for AppKit and the embedded dashboard", async () => {
  const resources = await collectMacOSLocalizationResources();
  assert.deepEqual(resources.relativeFiles, [
    "en.lproj/Localizable.strings",
    "localization/manifest.json",
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
        relativeFile: "localization/manifest.json",
        webRelativeFile: "localization/manifest.json",
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
