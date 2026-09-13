#!/usr/bin/env node

/**
 * Generate the static Electron main-process localization slice.
 *
 * The package catalog is the canonical source for shared copy. The separate
 * ownership input retains deliberately desktop-owned copy and the three named
 * compatibility overrides; the generated module contains no runtime import of
 * the workspace package or the browser localization surface.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const I18N_SOURCE_FILE = join(REPOSITORY_ROOT, "packages", "i18n", "index.js");
const ELECTRON_COPY_FILE = join(REPOSITORY_ROOT, "apps", "electron", "desktop-copy.js");
const ELECTRON_OWNERSHIP_SOURCE_FILE = join(
  REPOSITORY_ROOT,
  "apps",
  "electron",
  "desktop-copy-source.js",
);
const LOCALES = Object.freeze(["en-US", "zh-Hans", "es"]);
const OVERRIDE_KEYS = Object.freeze([
  "electron.menu.refresh",
  "electron.settings.codexFolder.title",
  "electron.settings.codexFolder.useDefault",
]);

export const I18N_ELECTRON_COPY_FILE = ELECTRON_COPY_FILE;

function digestSource(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function sourceUrl(path) {
  return `${pathToFileURL(path).href}?i18n-generator=${randomUUID()}`;
}

async function importFresh(path) {
  return import(sourceUrl(path));
}

function sortedKeys(value) {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function json(value) {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function assertLocaleRow(key, row, label) {
  assert.ok(row && typeof row === "object" && !Array.isArray(row), `${label}: ${key}`);
  assert.deepEqual(
    Object.keys(row).sort(),
    [...LOCALES].sort(),
    `${label}: ${key} locale set`,
  );
  for (const locale of LOCALES) {
    assert.equal(typeof row[locale], "string", `${label}: ${key}.${locale}`);
    assert.notEqual(row[locale].trim(), "", `${label}: ${key}.${locale} is blank`);
  }
  return Object.fromEntries(LOCALES.map((locale) => [locale, row[locale]]));
}

function normalizeRows(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return Object.fromEntries(
    sortedKeys(value).map((key) => [key, assertLocaleRow(key, value[key], label)]),
  );
}

function recoverDesktopOwnership(desktopModule, catalogs) {
  assert.ok(Array.isArray(desktopModule.DESKTOP_SHARED_KEYS),
    "desktop ownership must declare canonical shared keys");
  assert.ok(desktopModule.DESKTOP_OVERLAY_MESSAGES !== undefined,
    "desktop ownership must declare its overlay");
  assert.ok(desktopModule.DESKTOP_OVERRIDES !== undefined,
    "desktop ownership must declare its overrides");
  const sharedKeys = [...desktopModule.DESKTOP_SHARED_KEYS];
  assert.equal(
    new Set(sharedKeys).size,
    sharedKeys.length,
    "generated desktop shared keys must be unique",
  );
  assert.deepEqual(
    sharedKeys,
    [...sharedKeys].sort((left, right) => left.localeCompare(right)),
    "generated desktop shared keys must be sorted",
  );
  const overlay = normalizeRows(
    desktopModule.DESKTOP_OVERLAY_MESSAGES,
    "generated desktop overlay",
  );
  const overrides = normalizeRows(
    desktopModule.DESKTOP_OVERRIDES,
    "generated desktop overrides",
  );
  for (const key of sharedKeys) {
    assert.equal(Object.hasOwn(catalogs["en-US"], key), true, `shared key is canonical: ${key}`);
  }
  return { sharedKeys, overlay, overrides };
}

function validateOwnership({ sharedKeys, overlay, overrides }, catalogs) {
  const shared = new Set(sharedKeys);
  const overlayKeys = Object.keys(overlay);
  const overrideKeys = Object.keys(overrides);
  assert.equal(shared.size + overlayKeys.length + overrideKeys.length, 128,
    "desktop localization ownership must retain all 128 entries");
  assert.equal(new Set([...sharedKeys, ...overlayKeys, ...overrideKeys]).size, 128,
    "desktop localization ownership must not overlap");
  assert.deepEqual(overrideKeys, [...OVERRIDE_KEYS].sort(), "named desktop overrides changed");
  for (const key of sharedKeys) {
    assert.equal(Object.hasOwn(catalogs["en-US"], key), true, `missing canonical shared key: ${key}`);
  }
  for (const key of overlayKeys) {
    assert.equal(Object.hasOwn(catalogs["en-US"], key), false, `overlay became canonical: ${key}`);
  }
  for (const key of overrideKeys) {
    assert.equal(Object.hasOwn(catalogs["en-US"], key), true, `override is not canonical: ${key}`);
  }
}

function renderRows(name, rows) {
  const lines = [`const ${name} = Object.freeze({`];
  for (const key of sortedKeys(rows)) {
    lines.push(`  ${json(key)}: Object.freeze({`);
    for (const locale of LOCALES) {
      lines.push(`    ${json(locale)}: ${json(rows[key][locale])},`);
    }
    lines.push("  }),");
  }
  lines.push("});", "");
  return lines.join("\n");
}

function renderSharedRows(sharedKeys, catalogs) {
  const rows = Object.fromEntries(sharedKeys.map((key) => [
    key,
    Object.fromEntries(LOCALES.map((locale) => [locale, catalogs[locale][key]])),
  ]));
  return renderRows("DESKTOP_SHARED_MESSAGES", rows);
}

function renderPolicy() {
  return `const DESKTOP_DEFAULT_LOCALE = "en-US";
const DESKTOP_SYSTEM_LOCALE_PREFERENCE = "system";
const DESKTOP_SUPPORTED_LOCALES = Object.freeze([
  DESKTOP_DEFAULT_LOCALE,
  "zh-Hans",
  "es",
]);

// This dependency-free generated mirror is parity-tested against @app-usagemonitor/i18n.
function canonicalizeLocale(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

function localeParts(value) {
  const canonical = canonicalizeLocale(value);
  if (canonical === null) return null;
  const parts = canonical.split("-");
  const language = parts[0].toLowerCase();
  const script = parts.find((part) => /^[A-Za-z]{4}$/u.test(part));
  const region = parts.slice(1).find((part) => /^(?:[A-Za-z]{2}|\\d{3})$/u.test(part));
  return {
    canonical,
    language,
    script: script
      ? \`\${script.slice(0, 1).toUpperCase()}\${script.slice(1).toLowerCase()}\`
      : null,
    region: region?.toUpperCase() ?? null,
  };
}

function requestedLocaleValues(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function normalizedSupportedLocales(supportedLocales) {
  if (!Array.isArray(supportedLocales) || supportedLocales.length === 0) {
    throw new TypeError("At least one supported locale is required");
  }
  const result = [];
  for (const value of supportedLocales) {
    const canonical = canonicalizeLocale(value);
    if (canonical === null) throw new RangeError("Supported locales must be valid BCP 47 tags");
    if (!result.includes(canonical)) result.push(canonical);
  }
  return result;
}

function negotiateLocale(requestedLocales, supportedLocales = DESKTOP_SUPPORTED_LOCALES,
  fallbackLocale = DESKTOP_DEFAULT_LOCALE) {
  const supported = normalizedSupportedLocales(supportedLocales);
  const fallback = canonicalizeLocale(fallbackLocale);
  const resolvedFallback = fallback !== null && supported.includes(fallback)
    ? fallback
    : supported[0];
  for (const requestedValue of requestedLocaleValues(requestedLocales)) {
    const requested = localeParts(requestedValue);
    if (requested === null) continue;
    if (supported.includes(requested.canonical)) return requested.canonical;
    if (requested.language === "zh") {
      const simplified = requested.script === "Hans"
        || ["CN", "SG"].includes(requested.region);
      if (simplified && supported.includes("zh-Hans")) return "zh-Hans";
      continue;
    }
    const languageMatch = supported.find((locale) =>
      localeParts(locale)?.language === requested.language);
    if (languageMatch !== undefined) return languageMatch;
  }
  return resolvedFallback;
}

/** Resolve system/desktop preferences to one of the reviewed copy columns. */
export function resolveDesktopLocale(
  preference = DESKTOP_SYSTEM_LOCALE_PREFERENCE,
  systemLocales = [],
) {
  const requested = preference === DESKTOP_SYSTEM_LOCALE_PREFERENCE
    ? systemLocales
    : preference;
  return negotiateLocale(requested);
}

function interpolateDesktopMessage(message, values = {}) {
  if (typeof message !== "string") return "";
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("Desktop localization values must be an object");
  }
  return message.replace(/\\{([A-Za-z][A-Za-z0-9_.-]*)\\}/gu, (token, name) =>
    Object.hasOwn(values, name) && values[name] != null ? String(values[name]) : token);
}

export function desktopText(key, values = {}, {
  locale = DESKTOP_SYSTEM_LOCALE_PREFERENCE,
  systemLocales = [],
} = {}) {
  const messages = DESKTOP_MESSAGES[key];
  if (!messages) return key;
  const selected = messages[resolveDesktopLocale(locale, systemLocales)]
    ?? messages[DESKTOP_DEFAULT_LOCALE];
  return interpolateDesktopMessage(selected, values);
}

export {
  DESKTOP_DEFAULT_LOCALE,
  DESKTOP_MESSAGES,
  DESKTOP_OVERRIDES,
  DESKTOP_OVERLAY_MESSAGES,
  DESKTOP_SHARED_KEYS,
  DESKTOP_SUPPORTED_LOCALES,
  DESKTOP_SYSTEM_LOCALE_PREFERENCE,
  canonicalizeLocale,
  negotiateLocale,
};
`;
}

export async function buildI18nElectronCopy({
  sourceFile = I18N_SOURCE_FILE,
  desktopSourceFile = ELECTRON_OWNERSHIP_SOURCE_FILE,
} = {}) {
  const source = await readFile(sourceFile, "utf8");
  const ownershipSource = await readFile(desktopSourceFile, "utf8");
  const [canonicalModule, desktopModule] = await Promise.all([
    importFresh(sourceFile),
    importFresh(desktopSourceFile),
  ]);
  const catalogs = canonicalModule.CATALOGS;
  assert.ok(catalogs && typeof catalogs === "object", "canonical i18n catalogs are required");
  const ownership = recoverDesktopOwnership(desktopModule, catalogs);
  validateOwnership(ownership, catalogs);
  const overlay = normalizeRows(ownership.overlay, "desktop overlay");
  const overrides = normalizeRows(ownership.overrides, "desktop overrides");
  return [
    "// @generated by scripts/generate-i18n-electron-copy.js",
    "// Do not edit this Electron-served copy directly; update packages/i18n or the generator's named desktop ownership contract.",
    `// Canonical SHA-256: ${digestSource(source)}`,
    `// Desktop ownership SHA-256: ${digestSource(ownershipSource)}`,
    "",
    renderSharedRows(ownership.sharedKeys, catalogs),
    renderRows("DESKTOP_OVERLAY_MESSAGES", overlay),
    renderRows("DESKTOP_OVERRIDES", overrides),
    `const DESKTOP_SHARED_KEYS = Object.freeze(${json([...ownership.sharedKeys])});\n`,
    "const DESKTOP_MESSAGES = Object.freeze({",
    "  ...DESKTOP_SHARED_MESSAGES,",
    "  ...DESKTOP_OVERLAY_MESSAGES,",
    "  ...DESKTOP_OVERRIDES,",
    "});",
    "",
    renderPolicy(),
  ].join("\n");
}

export async function checkI18nElectronCopy({
  outputFile = ELECTRON_COPY_FILE,
  sourceFile = I18N_SOURCE_FILE,
  desktopSourceFile = ELECTRON_OWNERSHIP_SOURCE_FILE,
} = {}) {
  const actual = await readFile(outputFile, "utf8");
  const expected = await buildI18nElectronCopy({ sourceFile, desktopSourceFile });
  assert.equal(actual, expected, `${outputFile} is stale; regenerate it`);
  return true;
}

export async function writeI18nElectronCopy({
  outputFile = ELECTRON_COPY_FILE,
  sourceFile = I18N_SOURCE_FILE,
  desktopSourceFile = ELECTRON_OWNERSHIP_SOURCE_FILE,
} = {}) {
  const temporaryFile = `${outputFile}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporaryFile, "wx", 0o644);
    await handle.writeFile(
      await buildI18nElectronCopy({ sourceFile, desktopSourceFile }),
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryFile, outputFile);
    const directoryHandle = await open(dirname(outputFile), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    await unlink(temporaryFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const check = arguments_.includes("--check");
  const unexpected = arguments_.filter((argument) => argument !== "--check");
  assert.deepEqual(unexpected, [], `unexpected arguments: ${unexpected.join(" ")}`);
  if (check) {
    await checkI18nElectronCopy();
    return;
  }
  await writeI18nElectronCopy();
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
