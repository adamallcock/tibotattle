const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}|\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}/gu;
const DEFAULT_DATE_FORMAT_OPTIONS = Object.freeze({
  dateStyle: "medium",
  timeZone: "UTC",
});
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export const DEFAULT_LOCALE = "en-US";
export const SYSTEM_LOCALE_PREFERENCE = "system";
export const SUPPORTED_LOCALES = Object.freeze([
  DEFAULT_LOCALE,
  "zh-Hans",
  "es",
]);
export const LANGUAGE_OPTIONS = Object.freeze([
  Object.freeze({ id: SYSTEM_LOCALE_PREFERENCE, nativeLabel: "System" }),
  Object.freeze({ id: "en-US", nativeLabel: "English" }),
  Object.freeze({ id: "zh-Hans", nativeLabel: "简体中文" }),
  Object.freeze({ id: "es", nativeLabel: "Español" }),
]);

export const EN_US_CATALOG = Object.freeze({
  "app.name": "TiboTattle",
  "common.loading": "Loading…",
  "common.refresh": "Refresh",
  "dashboard.title": "Usage overview",
  "dashboard.lastUpdated": "Last updated {date}",
  "usage.events": "Usage events: {count}",
  "usage.tokens": "Tokens: {count}",
  "quota.remaining": "Remaining quota: {value}",
  "status.noData": "No usage data yet.",
  "status.error": "Something went wrong.",
  "language.system": "System",
  "language.english": "English",
  "language.simplifiedChinese": "Simplified Chinese",
  "language.spanish": "Spanish",
});

export const ZH_HANS_CATALOG = Object.freeze({
  "app.name": "TiboTattle",
  "common.loading": "正在加载…",
  "common.refresh": "刷新",
  "dashboard.title": "使用概览",
  "dashboard.lastUpdated": "最后更新：{date}",
  "usage.events": "使用事件：{count}",
  "usage.tokens": "令牌：{count}",
  "quota.remaining": "剩余额度：{value}",
  "status.noData": "暂无使用数据。",
  "status.error": "出现了问题。",
  "language.system": "跟随系统",
  "language.english": "English",
  "language.simplifiedChinese": "简体中文",
  "language.spanish": "Español",
});

export const ES_CATALOG = Object.freeze({
  "app.name": "TiboTattle",
  "common.loading": "Cargando…",
  "common.refresh": "Actualizar",
  "dashboard.title": "Resumen de uso",
  "dashboard.lastUpdated": "Última actualización: {date}",
  "usage.events": "Eventos de uso: {count}",
  "usage.tokens": "Tokens: {count}",
  "quota.remaining": "Cuota restante: {value}",
  "status.noData": "Aún no hay datos de uso.",
  "status.error": "Algo salió mal.",
  "language.system": "Sistema",
  "language.english": "English",
  "language.simplifiedChinese": "Chino simplificado",
  "language.spanish": "Español",
});

export const CATALOGS = Object.freeze({
  [DEFAULT_LOCALE]: EN_US_CATALOG,
  "zh-Hans": ZH_HANS_CATALOG,
  es: ES_CATALOG,
});

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
  // The first subtag is the language itself (for example, `zh`), not a
  // region. Looking across every subtag would incorrectly classify `zh-CN`
  // as region `ZH` and could make the safe Hans negotiation fall back.
  const region = parts.slice(1).find((part) => /^(?:[A-Za-z]{2}|\d{3})$/u.test(part));
  return {
    canonical,
    language,
    script: script
      ? `${script.slice(0, 1).toUpperCase()}${script.slice(1).toLowerCase()}`
      : null,
    region: region?.toUpperCase() ?? null,
  };
}

function requestedLocaleValues(requestedLocales) {
  if (Array.isArray(requestedLocales)) return requestedLocales;
  if (requestedLocales == null) return [];
  return [requestedLocales];
}

function normalizeSupportedLocales(supportedLocales) {
  if (!Array.isArray(supportedLocales) || supportedLocales.length === 0) {
    throw new TypeError("At least one supported locale is required");
  }

  const normalized = [];
  for (const locale of supportedLocales) {
    const canonical = canonicalizeLocale(locale);
    if (canonical === null) {
      throw new RangeError("Supported locales must be valid BCP 47 tags");
    }
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return normalized;
}

/**
 * Select an exact or safe language-compatible locale, then use the configured
 * fallback. `zh-TW`/`zh-Hant` never select a Simplified Chinese catalog.
 */
export function negotiateLocale(
  requestedLocales,
  supportedLocales = SUPPORTED_LOCALES,
  fallbackLocale = DEFAULT_LOCALE,
) {
  const supported = normalizeSupportedLocales(supportedLocales);
  const fallback = canonicalizeLocale(fallbackLocale);
  const fallbackMatch = fallback === null
    ? null
    : supported.find((locale) => locale === fallback);
  const resolvedFallback = fallbackMatch ?? supported[0];

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

export function resolveLocalePreference(
  preference,
  systemLocales,
  supportedLocales = SUPPORTED_LOCALES,
  fallbackLocale = DEFAULT_LOCALE,
) {
  if (preference === SYSTEM_LOCALE_PREFERENCE || preference == null) {
    return negotiateLocale(systemLocales, supportedLocales, fallbackLocale);
  }
  return negotiateLocale(preference, supportedLocales, fallbackLocale);
}

export function isLanguagePreference(value) {
  return value === SYSTEM_LOCALE_PREFERENCE || SUPPORTED_LOCALES.includes(value);
}

function assertCatalog(catalog) {
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new TypeError("A message catalog object is required");
  }
}

function assertMessageKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("A non-empty message key is required");
  }
}

function catalogMessage(catalog, key) {
  assertCatalog(catalog);
  assertMessageKey(key);
  return hasOwn(catalog, key) && typeof catalog[key] === "string"
    ? catalog[key]
    : undefined;
}

/**
 * Look up a string in a flat catalog. Missing keys return the key itself (or
 * the supplied fallback), which keeps an untranslated UI observable.
 */
export function getMessage(catalog, key, fallback = key) {
  assertMessageKey(key);
  if (fallback !== undefined && typeof fallback !== "string") {
    throw new TypeError("Message fallbacks must be strings");
  }
  return catalogMessage(catalog, key) ?? (fallback ?? key);
}

/**
 * Replace simple `{name}` or `{{name}}` tokens. Missing and nullish values are
 * retained as tokens so incomplete translations do not silently lose text.
 */
export function interpolateMessage(message, values = {}) {
  if (typeof message !== "string") {
    throw new TypeError("Interpolated messages must be strings");
  }
  if (values == null) values = {};
  if (typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("Interpolation values must be an object");
  }

  return message.replace(
    PLACEHOLDER_PATTERN,
    (token, doubleName, singleName) => {
      const name = doubleName ?? singleName;
      if (!hasOwn(values, name) || values[name] == null) return token;
      return String(values[name]);
    },
  );
}

/**
 * Resolve a message through locale catalogs, falling back to the fallback
 * locale's catalog and finally to the message key.
 */
export function translate(key, values = {}, options = {}) {
  assertMessageKey(key);
  const {
    locale = DEFAULT_LOCALE,
    catalogs = CATALOGS,
    fallbackLocale = DEFAULT_LOCALE,
  } = options ?? {};
  if (catalogs === null || typeof catalogs !== "object" || Array.isArray(catalogs)) {
    throw new TypeError("Catalogs must be an object keyed by locale");
  }

  const availableLocales = Object.keys(catalogs);
  const resolvedLocale = negotiateLocale(
    locale,
    availableLocales,
    fallbackLocale,
  );
  const resolvedFallback = negotiateLocale(
    fallbackLocale,
    availableLocales,
    resolvedLocale,
  );
  const message = catalogMessage(catalogs[resolvedLocale], key)
    ?? catalogMessage(catalogs[resolvedFallback], key)
    ?? key;
  return interpolateMessage(message, values);
}

function formattingLocale(locales) {
  for (const requested of requestedLocaleValues(locales)) {
    const canonical = canonicalizeLocale(requested);
    if (canonical !== null) return canonical;
  }
  return DEFAULT_LOCALE;
}

/**
 * Format a number with the requested valid Intl locale. Invalid locales use
 * en-US; formatting is independent from which message catalogs are installed.
 */
export function formatNumber(value, locale = DEFAULT_LOCALE, options) {
  return new Intl.NumberFormat(formattingLocale(locale), options).format(value);
}

export function formatPercent(value, locale = DEFAULT_LOCALE, options = {}) {
  return new Intl.NumberFormat(formattingLocale(locale), {
    style: "percent",
    ...options,
  }).format(value);
}

/**
 * Format a date with Intl. The default is a UTC medium date for deterministic
 * cross-runtime output; callers can provide any Intl.DateTimeFormat options.
 */
export function formatDate(value, locale = DEFAULT_LOCALE, options) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date value");
  return new Intl.DateTimeFormat(
    formattingLocale(locale),
    options === undefined ? DEFAULT_DATE_FORMAT_OPTIONS : options,
  ).format(date);
}
