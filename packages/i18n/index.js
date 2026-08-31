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
  "contribution.disconnect.action": "Disconnect this Mac",
  "contribution.disconnect.description": "Stop this Mac's uploads without deleting hosted history or local analysis. Signing out does not disconnect this Mac.",
  "contribution.disconnect.title": "Disconnect this Mac?",
  "contribution.disconnect.confirmation": "This revokes this Mac's upload connection and pauses its delivery. Your hosted sign-in, previously contributed history, other devices, and local analysis are kept. Connecting again requires an explicit Review and approve action.",
  "contribution.disconnect.cancel": "Cancel",
  "contribution.disconnect.checking": "Checking this Mac's upload connection…",
  "contribution.disconnect.ready": "This Mac has an upload connection. You do not need to be signed in to disconnect it.",
  "contribution.disconnect.absent": "No upload connection was found on this Mac. There is nothing to disconnect; hosted history and local analysis are unchanged.",
  "contribution.disconnect.unknown": "This Mac's upload connection could not be checked. You can still attempt to disconnect it; completion will only be reported if confirmed.",
  "contribution.disconnect.starting": "Disconnecting this Mac…",
  "contribution.disconnect.completed": "This Mac is disconnected and its delivery is paused. Your hosted sign-in, hosted history, other devices, and local analysis are unchanged.",
  "contribution.disconnect.cleanupPending": "This Mac's upload connection was revoked, but local cleanup is not confirmed complete. Try Disconnect this Mac again. Hosted history and local analysis are unchanged.",
  "contribution.disconnect.failed": "Disconnect was not confirmed. This Mac may still be able to upload. Try again, or reopen TiboTattle. Nothing is assumed disconnected or erased.",
  "contribution.disconnect.paused": "This Mac's delivery is paused after a disconnect request. To connect again, choose Review and approve. Hosted history and local analysis are unchanged.",
  "contribution.disconnect.signInToReconnect": "This Mac's delivery is paused after a disconnect request. Sign in, then choose Review and approve to connect again.",
  "contribution.disconnect.reviewCleanup": "Finish disconnect cleanup before connecting again. Try Disconnect this Mac again.",
  "contribution.signOutDetail": "Signing out ends this app's hosted session. It does not stop this Mac's uploads; use Disconnect this Mac for that.",
  "contribution.signOutCompleted": "Signed out. This Mac's upload connection is unchanged. Use Disconnect this Mac to stop its uploads.",
  "contribution.signOutUnfinished": "This unfinished sign-in was forgotten. No server session was created by it. This Mac's existing upload connection, if any, is unchanged.",
  "contribution.deviceLimit": "This account already has its maximum of connected Macs, so this Mac was not connected. Use Disconnect this Mac in TiboTattle on a Mac you no longer use, then connect this one again. Signing out does not disconnect a device. Nothing was uploaded.",
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
  "contribution.disconnect.action": "断开这台 Mac",
  "contribution.disconnect.description": "停止这台 Mac 的上传，不删除托管历史记录或本地分析。退出登录不会断开这台 Mac。",
  "contribution.disconnect.title": "断开这台 Mac？",
  "contribution.disconnect.confirmation": "此操作会撤销这台 Mac 的上传连接并暂停其传送。托管登录状态、已贡献的历史记录、其他设备和本地分析均会保留。重新连接需要明确选择“审阅并核准”。",
  "contribution.disconnect.cancel": "取消",
  "contribution.disconnect.checking": "正在检查这台 Mac 的上传连接…",
  "contribution.disconnect.ready": "这台 Mac 有上传连接。无需登录即可断开。",
  "contribution.disconnect.absent": "未在这台 Mac 上找到上传连接。无需断开；托管历史记录和本地分析未更改。",
  "contribution.disconnect.unknown": "无法检查这台 Mac 的上传连接。你仍可尝试断开；只有得到确认后才会报告完成。",
  "contribution.disconnect.starting": "正在断开这台 Mac…",
  "contribution.disconnect.completed": "这台 Mac 已断开，传送已暂停。托管登录状态、托管历史记录、其他设备和本地分析均未更改。",
  "contribution.disconnect.cleanupPending": "这台 Mac 的上传连接已撤销，但尚未确认本地清理完成。请再次选择“断开这台 Mac”。托管历史记录和本地分析未更改。",
  "contribution.disconnect.failed": "未确认断开成功。这台 Mac 可能仍能上传。请重试，或重新打开 TiboTattle。不能假定任何连接已断开或任何数据已擦除。",
  "contribution.disconnect.paused": "断开请求后，这台 Mac 的传送已暂停。若要重新连接，请选择“审阅并核准”。托管历史记录和本地分析未更改。",
  "contribution.disconnect.signInToReconnect": "断开请求后，这台 Mac 的传送已暂停。请先登录，再选择“审阅并核准”以重新连接。",
  "contribution.disconnect.reviewCleanup": "请先完成断开连接的清理，再重新连接。请再次选择“断开这台 Mac”。",
  "contribution.signOutDetail": "退出登录会结束此应用的托管会话，但不会停止这台 Mac 的上传；若要停止，请使用“断开这台 Mac”。",
  "contribution.signOutCompleted": "已退出登录。这台 Mac 的上传连接未更改。若要停止上传，请使用“断开这台 Mac”。",
  "contribution.signOutUnfinished": "这次未完成的登录已被忘记，未通过它创建服务器会话。这台 Mac 原有的上传连接（如有）未更改。",
  "contribution.deviceLimit": "此账户已达到连接 Mac 的数量上限，因此未连接这台 Mac。请在不再使用的 Mac 上通过 TiboTattle 选择“断开这台 Mac”，然后重新连接这一台。退出登录不会断开设备。未上传任何内容。",
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
  "contribution.disconnect.action": "Desconectar este Mac",
  "contribution.disconnect.description": "Detén las cargas de este Mac sin eliminar el historial alojado ni el análisis local. Cerrar sesión no desconecta este Mac.",
  "contribution.disconnect.title": "¿Desconectar este Mac?",
  "contribution.disconnect.confirmation": "Esto revoca la conexión de carga de este Mac y pausa sus envíos. Se conservan tu sesión alojada, el historial ya contribuido, los demás dispositivos y el análisis local. Para volver a conectarlo, debes elegir explícitamente Revisar y aprobar.",
  "contribution.disconnect.cancel": "Cancelar",
  "contribution.disconnect.checking": "Comprobando la conexión de carga de este Mac…",
  "contribution.disconnect.ready": "Este Mac tiene una conexión de carga. No necesitas iniciar sesión para desconectarlo.",
  "contribution.disconnect.absent": "No se encontró una conexión de carga en este Mac. No hay nada que desconectar; el historial alojado y el análisis local no han cambiado.",
  "contribution.disconnect.unknown": "No se pudo comprobar la conexión de carga de este Mac. Puedes intentar desconectarlo; solo se indicará que se completó cuando esté confirmado.",
  "contribution.disconnect.starting": "Desconectando este Mac…",
  "contribution.disconnect.completed": "Este Mac está desconectado y sus envíos están en pausa. Tu sesión alojada, el historial alojado, los demás dispositivos y el análisis local no han cambiado.",
  "contribution.disconnect.cleanupPending": "Se revocó la conexión de carga de este Mac, pero no se ha confirmado que la limpieza local haya terminado. Vuelve a elegir Desconectar este Mac. El historial alojado y el análisis local no han cambiado.",
  "contribution.disconnect.failed": "No se confirmó la desconexión. Es posible que este Mac aún pueda cargar datos. Inténtalo de nuevo o vuelve a abrir TiboTattle. No se da por desconectado ni borrado nada.",
  "contribution.disconnect.paused": "Los envíos de este Mac están en pausa tras una solicitud de desconexión. Para volver a conectarlo, elige Revisar y aprobar. El historial alojado y el análisis local no han cambiado.",
  "contribution.disconnect.signInToReconnect": "Los envíos de este Mac están en pausa tras una solicitud de desconexión. Inicia sesión y luego elige Revisar y aprobar para volver a conectarlo.",
  "contribution.disconnect.reviewCleanup": "Termina la limpieza de la desconexión antes de volver a conectarlo. Vuelve a elegir Desconectar este Mac.",
  "contribution.signOutDetail": "Cerrar sesión termina la sesión alojada de esta app. No detiene las cargas de este Mac; para eso, usa Desconectar este Mac.",
  "contribution.signOutCompleted": "Sesión cerrada. La conexión de carga de este Mac no ha cambiado. Usa Desconectar este Mac para detener sus cargas.",
  "contribution.signOutUnfinished": "Se olvidó este inicio de sesión incompleto. No se creó ninguna sesión de servidor mediante él. La conexión de carga que este Mac ya tuviera no ha cambiado.",
  "contribution.deviceLimit": "Esta cuenta ya tiene el máximo de Macs conectados, por lo que este Mac no se conectó. Usa Desconectar este Mac en TiboTattle en un Mac que ya no uses y luego conecta este. Cerrar sesión no desconecta un dispositivo. No se cargó nada.",
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
