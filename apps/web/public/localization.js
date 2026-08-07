// Shared browser-side localization policy for the loopback dashboard and the
// public community site. It deliberately has no runtime dependency: both
// surfaces are shipped as ordinary static ES modules, and a locale choice must
// work while the local companion is offline.

export const LOCALIZATION_SCHEMA_VERSION = "tibotattle-localization-v2";
export const SYSTEM_LANGUAGE_PREFERENCE = "system";
export const DEFAULT_LOCALE = "en-US";
export const SUPPORTED_LOCALES = Object.freeze([
  "en-US",
  "zh-Hans",
  "es",
]);
export const LANGUAGE_PREFERENCE_STORAGE_KEY =
  "tibotattle.language-preference.v1";

export const LANGUAGE_OPTIONS = Object.freeze([
  Object.freeze({
    id: SYSTEM_LANGUAGE_PREFERENCE,
    label: "System",
    nativeLabel: "System",
  }),
  Object.freeze({ id: "en-US", label: "English", nativeLabel: "English" }),
  Object.freeze({ id: "zh-Hans", label: "Simplified Chinese", nativeLabel: "简体中文" }),
  Object.freeze({ id: "es", label: "Spanish", nativeLabel: "Español" }),
]);

// These mirror the minimum point/span gates in `fitReset` in the weekly
// calibration contract. The browser catalog cannot import the Node-only
// reporting module, so keep the provenance explicit and guard the values with
// a source contract test.
export const WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES = 8;
export const WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP = 5;

const RTL_LANGUAGES = new Set([
  "ar",
  "arc",
  "ckb",
  "dv",
  "fa",
  "he",
  "nqo",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function canonicalLocale(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

function requestedValues(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function localeParts(value) {
  const canonical = canonicalLocale(value);
  if (canonical === null) return null;
  const parts = canonical.split("-");
  const language = parts[0].toLowerCase();
  const script = parts.find((part) => /^[A-Za-z]{4}$/u.test(part));
  // The first subtag is the language itself, not a region. This matters for
  // `zh-CN` / `zh-SG`: using `zh` as the region would wrongly bypass the
  // explicitly-safe Simplified Chinese match.
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

function normalizedSupportedLocales(supportedLocales) {
  if (!Array.isArray(supportedLocales) || supportedLocales.length === 0) {
    throw new TypeError("At least one supported locale is required");
  }
  const result = [];
  for (const value of supportedLocales) {
    const canonical = canonicalLocale(value);
    if (canonical === null) {
      throw new RangeError("Supported locales must be valid BCP 47 tags");
    }
    if (!result.includes(canonical)) result.push(canonical);
  }
  return result;
}

/**
 * Resolve a requested locale without treating Traditional Chinese as a match
 * for a Simplified-Chinese translation. Generic `zh` is intentionally not
 * enough evidence to select `zh-Hans`: its script is ambiguous.
 */
export function negotiateLocale(
  requestedLocales,
  supportedLocales = SUPPORTED_LOCALES,
  fallbackLocale = DEFAULT_LOCALE,
) {
  const supported = normalizedSupportedLocales(supportedLocales);
  const fallback = canonicalLocale(fallbackLocale);
  const resolvedFallback = fallback && supported.includes(fallback)
    ? fallback
    : supported[0];

  for (const requestedValue of requestedValues(requestedLocales)) {
    const requested = localeParts(requestedValue);
    if (requested === null) continue;
    if (supported.includes(requested.canonical)) return requested.canonical;

    if (requested.language === "zh") {
      const isSimplified = requested.script === "Hans"
        || ["CN", "SG"].includes(requested.region);
      if (isSimplified && supported.includes("zh-Hans")) return "zh-Hans";
      continue;
    }

    const languageMatch = supported.find((candidate) =>
      localeParts(candidate)?.language === requested.language);
    if (languageMatch) return languageMatch;
  }
  return resolvedFallback;
}

export function directionForLocale(locale) {
  const language = localeParts(locale)?.language;
  return language && RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}

export function isLanguagePreference(value) {
  return value === SYSTEM_LANGUAGE_PREFERENCE || SUPPORTED_LOCALES.includes(value);
}

function interpolate(message, values = {}) {
  if (typeof message !== "string") return "";
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("Localization values must be an object");
  }
  return message.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu, (token, key) =>
    hasOwn(values, key) && values[key] != null ? String(values[key]) : token);
}

// A compact semantic catalog for UI that is created after the HTML has loaded.
// New DOM code must use these stable keys; the exact-text catalog below is a
// bounded migration bridge for static markup and explicitly registered,
// product-owned legacy nodes only.
export const WEB_MESSAGES = Object.freeze({
  "language.label": ["Language", "语言", "Idioma"],
  "language.system": ["System", "跟随系统", "Sistema"],
  "language.english": ["English", "English", "English"],
  "language.simplifiedChinese": ["Simplified Chinese", "简体中文", "Chino simplificado"],
  "language.spanish": ["Spanish", "Español", "Español"],
  "language.changed": ["Language changed to {language}.", "语言已切换为{language}。", "Idioma cambiado a {language}."],
  "status.fresh": ["Fresh", "最新", "Actualizado"],
  "status.indexingHistory": ["Indexing history · {indexed} of {total}", "正在索引历史 · {indexed}/{total}", "Indexando historial · {indexed} de {total}"],
  "status.running": ["Running", "运行中", "En ejecución"],
  "status.upToDate": ["Up to date", "已是最新", "Actualizado"],
  "status.updating": ["Updating", "正在更新", "Actualizando"],
  "status.needsRefresh": ["Needs refresh", "需要刷新", "Necesita actualización"],
  "status.moreDataNeeded": ["More data needed", "需要更多数据", "Se necesitan más datos"],
  "status.setUpMac": ["Set up this Mac", "设置这台 Mac", "Configura este Mac"],
  "status.readyToAnalyze": ["Ready to analyze", "可以分析", "Listo para analizar"],
  "status.openMacApp": ["Open the Mac app", "打开 Mac 应用", "Abre la app para Mac"],
  "status.labeledDemoData": ["Labeled demo data", "已标注的演示数据", "Datos de demostración etiquetados"],
  "dashboard.comparison.matchedWindow": ["Matched window", "匹配窗口", "Ventana coincidente"],
  "dashboard.comparison.mae": ["MAE {value} pp", "平均绝对误差 {value} 个百分点", "EMA de {value} pp"],
  "dashboard.comparison.latestMovement": ["{residual} separates the observed and cost-implied movement in the latest matched window.", "最新匹配窗口中，观测变化与成本推断变化相差 {residual}。", "{residual} separa el movimiento observado del implícito por coste en la última ventana coincidente."],
  "dashboard.comparison.seriesBand": ["Across the series, {percent} of points fall inside the modeled 80% band.", "在整个序列中，{percent} 的点落在建模的 80% 区间内。", "En la serie, el {percent} de los puntos cae dentro de la banda modelada del 80 %."],
  "dashboard.contract": ["Dashboard contract: {version}", "仪表板契约：{version}", "Contrato del panel: {version}"],
  "dashboard.unavailable.backendOnlyOrigin": ["Backend-only origin", "仅后端来源", "Origen solo de backend"],
  "dashboard.unavailable.companionUnavailable": ["Companion unavailable", "伴随程序不可用", "Acompañante no disponible"],
  "dashboard.unavailable.noRealUsage": ["No real usage is displayed", "未显示真实使用情况", "No se muestra uso real"],
  "dashboard.unavailable.backendOnlyTitle": ["This address is the backend-only service", "此地址是仅后端服务", "Esta dirección es el servicio solo de backend"],
  "dashboard.unavailable.backendOnlyCopy": ["This service accepts optional community requests but cannot read this Mac. Open TiboTattle from Applications and use its in-app window.", "此服务接受可选的社区请求，但无法读取这台 Mac。请从“应用程序”打开 TiboTattle，并使用其应用内窗口。", "Este servicio acepta solicitudes comunitarias opcionales, pero no puede leer este Mac. Abre TiboTattle desde Aplicaciones y usa su ventana integrada."],
  "dashboard.unavailable.dashboardTitle": ["The companion could not load the local dashboard", "伴随程序无法加载本地仪表板", "El acompañante no pudo cargar el panel local"],
  "dashboard.unavailable.dashboardCopy": ["The Mac app is running, but its in-app dashboard could not be loaded. Quit and reopen TiboTattle, then open the dashboard in its window and check again.", "Mac 应用正在运行，但无法加载其应用内仪表板。退出并重新打开 TiboTattle，然后在其窗口中打开仪表板并再次检查。", "La app para Mac está en ejecución, pero no se pudo cargar su panel integrado. Cierra y vuelve a abrir TiboTattle, luego abre el panel en su ventana y comprueba de nuevo."],
  "dashboard.unavailable.companionTitle": ["The local companion is not available", "本地伴随程序不可用", "El acompañante local no está disponible"],
  "dashboard.unavailable.companionCopy": ["Open TiboTattle from Applications, wait for Ready, then open the dashboard in its window. If no installer is published below, this build is not yet available for a new installation.", "从“应用程序”打开 TiboTattle，等待显示“就绪”，然后在其窗口中打开仪表板。如果下方没有发布安装程序，此构建尚不可用于新的安装。", "Abre TiboTattle desde Aplicaciones, espera a que esté Listo y luego abre el panel en su ventana. Si no hay un instalador publicado a continuación, esta compilación aún no está disponible para una instalación nueva."],
  "dashboard.unavailable.companionInAppCopy": ["The local service stopped. Try Refresh, then quit and reopen TiboTattle and try again. If it still fails, contact Support.", "本地服务已停止。请先使用“刷新”，然后退出并重新打开 TiboTattle 再试一次。如果仍然失败，请联系支持。", "El servicio local se detuvo. Prueba Actualizar; luego cierra y vuelve a abrir TiboTattle e inténtalo de nuevo. Si sigue fallando, contacta con Soporte."],
  "dashboard.unavailable.noLocalEvidence": ["No local evidence", "没有本地证据", "Sin evidencia local"],
  "dashboard.unavailable.offline": ["Offline", "离线", "Sin conexión"],
  "dashboard.unavailable.emptyState": ["This empty state is intentional. Demo values are never substituted automatically.", "此空状态是有意设计的。绝不会自动替换为演示值。", "Este estado vacío es intencional. Los valores de demostración nunca se sustituyen automáticamente."],
  "dashboard.quota.observations": ["Quota observations", "额度观测", "Observaciones de cuota"],
  "dashboard.quota.insufficient": ["Insufficient", "不足", "Insuficiente"],
  "dashboard.quota.noCurrent": ["The local companion has not exposed a current normal Codex allowance window.", "本地伴随程序尚未提供当前的正常 Codex 额度窗口。", "El acompañante local no ha expuesto una ventana actual de asignación normal de Codex."],
  "dashboard.quota.demo": ["Demo", "演示", "Demostración"],
  "dashboard.quota.observed": ["Observed", "已观测", "Observado"],
  "dashboard.quota.windowFiveHour": ["Five-hour allowance", "五小时额度", "Asignación de cinco horas"],
  "dashboard.quota.windowSevenDay": ["Seven-day allowance", "七天额度", "Asignación de siete días"],
  "dashboard.quota.windowSpark": ["Spark allowance", "Spark 额度", "Asignación de Spark"],
  "dashboard.quota.spark": ["Spark · separate limit", "Spark · 独立额度", "Spark · límite separado"],
  "dashboard.quota.windowProviderReported": ["Provider-reported {duration} window", "提供方报告的 {duration} 窗口", "Ventana de {duration} informada por el proveedor"],
  "dashboard.quota.windowOther": ["Other observed allowance", "其他观测到的额度", "Otra asignación observada"],
  "dashboard.quota.providerPlan": ["Provider-reported plan: {plan}", "提供方报告的方案：{plan}", "Plan informado por el proveedor: {plan}"],
  "dashboard.quota.providerPlanUnavailable": ["Provider-reported plan unavailable", "提供方报告的方案不可用", "Plan informado por el proveedor no disponible"],
  "shareCard.showInFinder": ["Show in Finder", "在访达中显示", "Mostrar en Finder"],
  "dashboard.quota.remaining": ["{value} remaining", "剩余 {value}", "{value} restante"],
  "dashboard.quota.used": ["{value} used", "已使用 {value}", "{value} usado"],
  "dashboard.quota.usedUnknown": ["Used unknown", "已用量未知", "Uso desconocido"],
  "dashboard.quota.resets": ["Resets {time}", "重置时间：{time}", "Se restablece {time}"],
  "dashboard.quota.resetUnknown": ["Reset unknown", "重置时间未知", "Restablecimiento desconocido"],
  "dashboard.quota.observedAt": ["Observed {time} · {attribution}", "观测于 {time} · {attribution}", "Observado {time} · {attribution}"],
  "dashboard.quota.observedAtPlain": ["Observed {time}", "观测于 {time}", "Observado {time}"],
  "format.localTime": ["Local time", "本地时间", "Hora local"],
  "dashboard.quota.attributionPseudonymous": ["pseudonymous account attributed", "已归因于假名化帐户", "cuenta seudónima atribuida"],
  "dashboard.quota.attributionUnavailable": ["account unattributed", "未归因帐户", "cuenta sin atribución"],
  "dashboard.pricing.noWeightedTitle": ["No usage in this period could be weighted, so the Standard-rate total is shown unchanged.", "此期间没有可加权的使用量，因此显示未变动的 Standard 费率总额。", "No se pudo ponderar ningún uso en este período, por lo que se muestra sin cambios el total a tarifa Standard."],
  "dashboard.pricing.noCoverage": ["Price coverage is not available", "价格覆盖率不可用", "La cobertura de precios no está disponible"],
  "dashboard.pricing.coverageDenominator": ["Based on {count} usage changes in the displayed period.", "基于所显示期间的 {count} 个使用变化。", "Basado en {count} cambios de uso durante el período mostrado."],
  "dashboard.pricing.coverage": ["{percent} coverage · {method}{provenance}", "覆盖率 {percent} · {method}{provenance}", "{percent} de cobertura · {method}{provenance}"],
  "dashboard.pricing.noCoverageWithHistory": ["Price coverage is not available · {history}", "价格覆盖率不可用 · {history}", "La cobertura de precios no está disponible · {history}"],
  "dashboard.pricing.coverageWithHistory": ["{percent} coverage · {method}{provenance} · {history}", "覆盖率 {percent} · {method}{provenance} · {history}", "{percent} de cobertura · {method}{provenance} · {history}"],
  "dashboard.pricing.registryProvenance": [" · price registry {version}{observedAt}", " · 价格登记表 {version}{observedAt}", " · registro de precios {version}{observedAt}"],
  "dashboard.pricing.registryObservedAt": [" ({time})", "（{time}）", " ({time})"],
  "dashboard.pricing.replaySafe": ["replay-safe", "可安全重放", "seguro para reproducción"],
  "dashboard.pricing.staleReplaySafe": ["stale replay-safe cache", "陈旧的可安全重放缓存", "caché seguro para reproducción desactualizado"],
  "dashboard.pricing.legacyProjection": ["legacy projection", "旧版投影", "proyección heredada"],
  "dashboard.pricing.noComponents": ["No token-component accounting was returned.", "未返回令牌组件核算。", "No se devolvió contabilidad por componente de token."],
  "dashboard.pricing.tokens": ["{count} tokens", "{count} 个令牌", "{count} tokens"],
  "dashboard.pricing.historyScanningComplete": ["Scanning for older history", "正在扫描更早的历史记录", "Buscando historial anterior"],
  "dashboard.pricing.historyScanningPartial": ["Scanning for older history", "正在扫描更早的历史记录", "Buscando historial anterior"],
  "dashboard.pricing.historyComplete": ["History index complete", "历史索引完成", "Índice histórico completo"],
  "dashboard.pricing.historyDiskSpace": ["History scan paused: free space needed", "历史扫描已暂停：需要可用空间", "Análisis histórico en pausa: se necesita espacio libre"],
  "dashboard.pricing.historyStorageUnavailable": ["History scan paused: storage check unavailable", "历史扫描已暂停：无法检查存储空间", "Análisis histórico en pausa: no se puede comprobar el almacenamiento"],
  "dashboard.pricing.historyNotStarted": ["Older history has not been scanned", "尚未扫描更早的历史记录", "Aún no se ha analizado el historial anterior"],
  "dashboard.pricing.historyProgress": ["History scan: {indexed} of {total} files", "历史扫描：{indexed}/{total} 个文件", "Análisis histórico: {indexed} de {total} archivos"],
  "dashboard.pricing.historyResume": ["History scan paused", "历史扫描已暂停", "Análisis histórico en pausa"],
  // How much of the discovered history the figures above are drawn from. Every
  // number here is measured — indexed and discovered source counts published by
  // the local companion — so the share is a real proportion of a real
  // denominator and never a synthesized completion estimate. No key here claims
  // a finish time, because none is known.
  "dashboard.history.indexingActive": [
    "Indexing your history now — {percent} covered so far",
    "正在索引你的历史记录 — 目前已覆盖 {percent}",
    "Indexando tu historial ahora: {percent} cubierto hasta ahora",
  ],
  "dashboard.history.indexingPaused": [
    "History indexing is part-way through — {percent} covered so far",
    "历史索引进行到一半 — 目前已覆盖 {percent}",
    "La indexación del historial está a medias: {percent} cubierto hasta ahora",
  ],
  "dashboard.history.indexingNotStarted": [
    "Your older history has not been indexed yet",
    "尚未索引你更早的历史记录",
    "Tu historial anterior aún no se ha indexado",
  ],
  "dashboard.history.indexingSources": [
    "{indexed} of {total} discovered sources indexed ({bytesIndexed} of {bytesTotal}). Every figure on this page is drawn from that share and will change as the index advances.",
    "已索引 {total} 个已发现来源中的 {indexed} 个（{bytesIndexed}/{bytesTotal}）。本页的每个数字都基于这一部分，并会随着索引推进而变化。",
    "{indexed} de {total} fuentes descubiertas indexadas ({bytesIndexed} de {bytesTotal}). Cada cifra de esta página procede de esa parte y cambiará a medida que avance el índice.",
  ],
  "dashboard.stale.accountingTitle": [
    "The cached cost accounting is stale, not your observations",
    "陈旧的是缓存的成本核算，而不是你的观测数据",
    "Lo desactualizado es la contabilidad de costes en caché, no tus observaciones",
  ],
  "dashboard.stale.accountingCopy": [
    "The newest local observation is current. The cached accounting result behind the cost figures is older than its threshold, so those figures are rebuilt by the next local analysis.",
    "最新的本地观测数据是当前的。成本数字背后的缓存核算结果已超过其阈值，因此这些数字会在下一次本地分析时重建。",
    "La observación local más reciente está al día. El resultado contable en caché que respalda las cifras de coste supera su umbral, por lo que esas cifras se reconstruyen en el próximo análisis local.",
  ],
  "dashboard.history.indexingResumes": [
    "Indexing continues on the next update; no completion time is known.",
    "索引将在下次更新时继续；完成时间未知。",
    "La indexación continúa en la próxima actualización; no se conoce la hora de finalización.",
  ],
 "accounting.pricing.partialCoverage": ["{percent} of usage changes have a reviewed price; coverage is partial.", "使用变化中有 {percent} 使用了经审核的价格；覆盖率不完整。", "El {percent} de los cambios de uso tiene un precio revisado; la cobertura es parcial."],
 "accounting.pricing.coverageReviewed": ["All usage changes in this period have reviewed pricing.", "此期间的所有使用变化都有经审核的价格。", "Todos los cambios de uso de este período tienen precios revisados."],
  "accounting.pricing.coverageShort": ["{percent} coverage", "{percent} 覆盖率", "{percent} de cobertura"],
  "accounting.model.noneInPeriod": ["No model usage in this period.", "此期间没有模型使用记录。", "No hay uso de modelos en este período."],
  "accounting.model.unrecognized": ["Unrecognized model", "无法识别的模型", "Modelo no reconocido"],
  "accounting.model.separateAllowanceChip": ["Separate allowance", "独立额度", "Cuota independiente"],
  // Deliberately a marker, not a figure. Spark is metered against its own
  // pool, so there is no API-price equivalent to state here — not a zero, and
  // not a smaller number. The em dash is the same "no figure" glyph the rest of
  // this column uses; the asterisk carries the reason to the footnote under the
  // table, where the sentence has room to be read once instead of per row.
  "accounting.model.separateAllowance": ["—*", "—*", "—*"],
  "accounting.model.separateAllowanceTitle": ["This model is metered against its own subscription allowance, so an API-price equivalent cannot be compared with the main pool.", "该模型按其自身的订阅额度计量，因此其 API 价格等价值无法与主额度池比较。", "Este modelo se contabiliza con su propia cuota de suscripción, por lo que un equivalente de precio de API no se puede comparar con la cuota principal."],
  "accounting.model.noPublishedPrice": ["No published price", "没有公开价格", "Sin precio publicado"],
  "accounting.model.noPublishedPriceTitle": ["This model is recognized, but no public API price card is published for it, so no price is invented.", "该模型可被识别，但没有公开的 API 价格卡，因此不会虚构价格。", "Este modelo se reconoce, pero no hay una tarjeta pública de precios de API para él, así que no se inventa ningún precio."],
  "accounting.model.notPricedUnknown": ["Not priced", "未计价", "Sin precio"],
  "accounting.model.notPricedUnknownTitle": ["This model identifier has not been reviewed, so no price is applied to it. It is not a zero.", "此模型标识尚未经过审核，因此不会为其应用任何价格。这不是零。", "Este identificador de modelo no se ha revisado, por lo que no se le aplica ningún precio. No es un cero."],
  "accounting.model.notReported": ["Not reported", "未报告", "No informado"],
  "accounting.model.notReportedTitle": ["No usable figure was reported for this row. It is shown as missing rather than as zero.", "此行没有报告可用的数值。它显示为缺失而不是零。", "No se informó ninguna cifra utilizable para esta fila. Se muestra como ausente, no como cero."],
  "accounting.model.zeroTitle": ["A priced total that rounds to zero for this period.", "此期间计价后的总额四舍五入为零。", "Un total con precio que se redondea a cero en este período."],
  "accounting.period.indexedHistory": ["Indexed history", "已索引历史", "Historial indexado"],
  "accounting.period.indexedHistorySoFar": ["Indexed history so far", "目前已索引的历史", "Historial indexado hasta ahora"],
  "accounting.fastMode.noUsage": ["No usage increments in this period, so there is no speed-mode attribution to report.", "此期间没有使用增量，因此没有可报告的速度模式归因。", "No hay incrementos de uso en este período, por lo que no hay atribución de modo de velocidad que informar."],
  "accounting.fastMode.observed": ["{count} observed in the logs", "日志中观测到 {count} 个", "{count} observados en los registros"],
  "accounting.fastMode.stated": ["{count} attributed from your stated mode", "根据你声明的模式归因 {count} 个", "{count} atribuidos a tu modo declarado"],
  "accounting.fastMode.inferred": ["{count} inferred from calibration residuals", "根据校准残差推断 {count} 个", "{count} inferidos a partir de residuos de calibración"],
  "accounting.fastMode.unknown": ["{count} still unknown", "仍有 {count} 个未知", "{count} aún desconocidos"],
  "accounting.fastMode.unknownShare": [" ({percent} of increments).", "（占增量的 {percent}）。", " ({percent} de los incrementos)."],
  "accounting.fastMode.unweighted": [" {amount} of Standard-rate cost could not be weighted and is excluded from the weighted total rather than counted at 1x.", " 有 {amount} 的标准费率成本无法加权，因此从加权总额中排除，而不是按 1 倍计入。", " {amount} de coste a tarifa Standard no pudo ponderarse y se excluye del total ponderado en lugar de contarse a 1×."],
  "accounting.fastMode.coverage": ["Of {total} usage increments: {parts}{share}{unweighted} Codex records the mode only when it is applied or changed, so turns before the first change in a session are never observed and a small structural error in the calibration cannot be engineered away.", "在 {total} 个使用增量中：{parts}{share}{unweighted} Codex 只会在模式被应用或更改时记录该模式，因此会话中首次更改前的轮次永远不会被观测到，校准中的小型结构性误差也无法人为消除。", "De {total} incrementos de uso: {parts}{share}{unweighted} Codex registra el modo solo cuando se aplica o cambia, por lo que los turnos anteriores al primer cambio de una sesión nunca se observan y no se puede eliminar mediante ingeniería un pequeño error estructural de la calibración."],
  "accounting.fastMode.inferenceNotRun": ["Residual inference has not run: there is not yet enough matched calibration evidence to compare a window against a Standard reference.", "残差推断尚未运行：还没有足够的匹配校准证据将某个窗口与 Standard 参考进行比较。", "La inferencia de residuos no se ha ejecutado: todavía no hay suficiente evidencia de calibración coincidente para comparar una ventana con una referencia Standard."],
  "accounting.fastMode.inferenceNone": ["Residual inference compared {scored} calibration windows against {reference} Standard references and marked none as Fast.", "残差推断将 {scored} 个校准窗口与 {reference} 个 Standard 参考进行了比较，没有标记任何一个为 Fast。", "La inferencia de residuos comparó {scored} ventanas de calibración con {reference} referencias Standard y no marcó ninguna como Fast."],
  "accounting.fastMode.inferenceSome": ["Residual inference marked {fast} of {scored} calibration windows as inferred Fast, against {reference} Standard references. Inference labels windows, never individual increments, so it is reported here and never folded into the weighted total.", "残差推断在与 {reference} 个 Standard 参考比较后，将 {scored} 个校准窗口中的 {fast} 个标记为推断的 Fast。推断标记的是窗口而非单个增量，因此只在此报告，绝不会并入加权总额。", "La inferencia de residuos marcó {fast} de {scored} ventanas de calibración como Fast inferido, frente a {reference} referencias Standard. La inferencia etiqueta ventanas, nunca incrementos individuales, por lo que se informa aquí y nunca se incorpora al total ponderado."],
  "dashboard.calibration.perPoint": ["{amount} API equivalent per 1 percentage point", "每 1 个百分点相当于 {amount} 的 API 价值", "{amount} de equivalente de API por cada punto porcentual"],
  "dashboard.calibration.range": ["{lower}–{upper} per point", "每点 {lower}–{upper}", "{lower}–{upper} por punto"],
  "dashboard.calibration.rangeUnavailable": ["Range unavailable", "区间不可用", "Intervalo no disponible"],
  "dashboard.calibration.example": ["$100 of recorded API-price-equivalent usage corresponds to about {points} percentage points", "记录的 API 价格等价值使用量每 100 美元约对应 {points} 个百分点", "100 USD de uso registrado equivalente al precio de API corresponden a unos {points} puntos porcentuales"],
  "dashboard.calibration.noRate": [`The weekly calibration contract requires at least ${WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES} unique quota-boundary observations spanning at least ${WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP} displayed percentage points, plus a valid positive fit, before TiboTattle can estimate this rate and range. API prices remain a measuring stick, not a subscription charge.`, `每周校准契约要求至少 ${WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES} 个唯一额度边界观测值，跨度至少为 ${WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP} 个显示百分点，并且拟合必须有效且为正，TiboTattle 才能估算此费率和区间。API 价格仍只是衡量尺，而不是订阅费用。`, `El contrato de calibración semanal exige al menos ${WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES} observaciones únicas de límites de cuota que abarquen al menos ${WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP} puntos porcentuales mostrados, además de un ajuste positivo válido, antes de que TiboTattle pueda estimar esta tasa y su intervalo. Los precios de API siguen siendo una referencia, no un cargo de suscripción.`],
  "dashboard.calibration.withRange": ["Across {count} qualifying resets, the fitted seven-day allowance is {amount}; the middle 80% of those estimates spans {lower}–{upper}. Observed movement comes from the provider. Cost-implied movement translates local activity using the price in effect when each event occurred.", "在 {count} 次合格重置中，拟合的七天额度为 {amount}；这些估计的中间 80% 范围为 {lower}–{upper}。观测变化来自提供商。成本推算变化使用每个事件发生时有效的价格换算本地活动。", "En {count} reinicios válidos, el límite ajustado de siete días es {amount}; el 80 % central de esas estimaciones abarca {lower}–{upper}. El movimiento observado procede del proveedor. El movimiento implícito por coste traduce la actividad local con el precio vigente cuando ocurrió cada evento."],
  "dashboard.calibration.withoutRange": ["The central fit implies a full 100-point allowance near {amount} API equivalent, but there is not yet a usable across-reset range. This is not a provider-published dollar cap.", "中心拟合表明完整的 100 点额度约为 {amount} 的 API 等价值，但尚无可用的跨重置区间。这不是提供商公布的美元上限。", "El ajuste central implica una asignación completa de 100 puntos cercana a {amount} de equivalente de API, pero todavía no hay un intervalo utilizable entre restablecimientos. No es un límite monetario publicado por el proveedor."],
  "dashboard.timeWindow.fifteenMinutes": ["15-minute", "15 分钟", "15 minutos"],
  "dashboard.timeWindow.hours": ["{count}-hour", "{count} 小时", "{count} horas"],
  // A chart labelled with a range it does not actually cover. The reader is
  // otherwise left to read a truncated series as a quiet month.
  "dashboard.series.shortOfRange": [
    "This chart is labelled {claimed} but the retained series only reaches back {covered}. Nothing older is drawn.",
    "此图表标注为 {claimed}，但保留的序列仅回溯 {covered}。更早的数据未绘制。",
    "Este gráfico está etiquetado como {claimed}, pero la serie conservada solo abarca {covered}. No se dibuja nada anterior.",
  ],
  "dashboard.series.shortOfRangeWithheldCache": [
    "This chart is labelled {claimed} but the retained series only reaches back {covered}. Cached accounting is withheld, so the trend is drawn from the smaller live collector projection until a local analysis rebuilds it.",
    "此图表标注为 {claimed}，但保留的序列仅回溯 {covered}。缓存的核算数据已被暂缓使用，因此在本地分析重建之前，趋势图使用范围更小的实时采集投影绘制。",
    "Este gráfico está etiquetado como {claimed}, pero la serie conservada solo abarca {covered}. La contabilidad en caché está retenida, así que la tendencia se dibuja a partir de la proyección en vivo del recolector, más pequeña, hasta que un análisis local la reconstruya.",
  ],
  "dashboard.timeline.title": ["{window} rolling quota change versus cost-implied change", "{window} 滚动额度变化与成本推断变化的对比", "Cambio móvil de cuota de {window} frente al cambio implícito por coste"],
  "dashboard.timeline.liveCopy": ["Usage changes and quota movement shown in {timeZone}.", "使用变化和额度变化显示为 {timeZone}。", "Los cambios de uso y de cuota se muestran en {timeZone}."],
  "dashboard.timeline.historicalCopy": ["Historical local calibration artifact from {generatedAt} · recent quota snapshots are too sparse to bracket {window} endpoints", "来自 {generatedAt} 的历史本地校准产物 · 最近的额度快照过于稀疏，无法界定 {window} 的端点", "Artefacto histórico de calibración local de {generatedAt} · las instantáneas recientes de cuota son demasiado escasas para acotar los extremos de {window}"],
  "dashboard.timeline.notComparableYet": ["Not comparable yet", "尚不可比较", "Aún no comparable"],
  "dashboard.timeline.noBracket": ["Cost history exists, but quota observations do not bracket any {window} window in this date range. The calculated line is hidden until there is measured evidence to compare it with.", "存在成本历史记录，但额度观测无法在此日期范围内界定任何 {window} 窗口。在有可供比较的测量证据前，计算线会保持隐藏。", "Existe historial de costes, pero las observaciones de cuota no delimitan ninguna ventana de {window} en este intervalo de fechas. La línea calculada permanece oculta hasta que haya evidencia medida con la que compararla."],
  "dashboard.timeline.missingData": ["This is a missing-data state, not a zero-usage period.", "这是缺失数据状态，不是零使用期。", "Es un estado de datos faltantes, no un período de uso cero."],
  "dashboard.timeline.observedQuota": ["Observed quota change", "观测到的额度变化", "Cambio de cuota observado"],
  "dashboard.timeline.expectedCost": ["Expected from API cost", "按 API 成本推断的预期变化", "Esperado según el coste de API"],
  "dashboard.timeline.percentagePoints": ["Percentage points", "百分点", "Puntos porcentuales"],
  "dashboard.timeline.movementTitle": ["{window} rolling quota movement", "{window} 滚动额度变化", "Movimiento móvil de cuota de {window}"],
  "dashboard.timeline.chartDescription": ["Observed quota movement compared with movement implied by priced token usage, with times shown in {timeZone}.", "将观测到的额度变化与按定价令牌使用量推断的变化进行比较，时间显示为 {timeZone}。", "Movimiento de cuota observado comparado con el movimiento implícito por el uso de tokens con precio; las horas se muestran en {timeZone}."],
  "dashboard.timeline.lowConfidence": ["Low confidence: only {visible}; {excluded}.", "置信度较低：仅显示 {visible}；{excluded}。", "Confianza baja: solo {visible}; {excluded}."],
  "dashboard.timeline.excludedShown": ["{shown}. {excluded} and are shaded above; do not read them as zero usage.", "{shown}。{excluded}，并在上方显示为阴影；不要将它们理解为零使用。", "{shown}. {excluded}, se muestran sombreadas arriba; no las interpretes como uso cero."],
  "dashboard.timeline.allMatched": ["{visible}. This compares observed percentage-point movement with a priced-token estimate; it is not a provider-published allowance.", "{visible}。这会将观测到的百分点变化与按定价令牌估算值进行比较；它不是提供商公布的额度。", "{visible}. Esto compara el movimiento observado en puntos porcentuales con una estimación de tokens con precio; no es una asignación publicada por el proveedor."],
  "dashboard.timeline.resetView": ["Use Reset view to return to the selected date range.", "使用“重置视图”返回所选日期范围。", "Usa Restablecer vista para volver al intervalo de fechas seleccionado."],
  "dashboard.timeline.aria": ["Interactive quota timeline in {timeZone}. Use plus or minus to zoom, arrow keys to pan, Home to reset, or drag horizontally.", "{timeZone} 的交互式额度时间线。使用加号或减号缩放，方向键平移，Home 重置，或水平拖动。", "Cronología interactiva de cuota en {timeZone}. Usa más o menos para ampliar, las flechas para desplazar, Inicio para restablecer o arrastra horizontalmente."],
  "dashboard.timeline.status": ["Timeline shows {start} through {end}, a span of {span}.", "时间线显示从 {start} 到 {end}，跨度为 {span}。", "La cronología muestra de {start} a {end}, con una duración de {span}."],
  "dashboard.residual.partial": ["{computed} of {total} windows in this range have a computable residual. The other {missing} are shown as shaded gaps on the same axis, never as zero: {reasons}.", "此范围内 {total} 个窗口中有 {computed} 个具有可计算的残差。其余 {missing} 个会在同一轴上显示为阴影缺口，绝不显示为零：{reasons}。", "{computed} de las {total} ventanas de este intervalo tienen un residual calculable. Las otras {missing} se muestran como huecos sombreados en el mismo eje, nunca como cero: {reasons}."],

  // Every string the chart renderer stamps into the SVG text layer — axis
  // labels, series names, the <title>/<desc> accessibility pair, and hover
  // tooltips — resolves through these keys. `lineChart` refuses a bare string,
  // so a chart added later cannot quietly reintroduce hardcoded English behind
  // the `data-i18n-skip` attribute the SVG text nodes must keep.
  "chart.seriesValue": ["{label}: {value}", "{label}：{value}", "{label}: {value}"],
  "chart.timeZoneNote": ["Times shown in {timeZone}.", "时间显示为 {timeZone}。", "Las horas se muestran en {timeZone}."],
  "chart.axis.apiEquivalentPerHour": ["$ API equivalent per hour", "每小时的 API 等价美元", "$ equivalente de API por hora"],
  "chart.axis.apiEquivalentPerDay": ["$ API equivalent per day", "每天的 API 等价美元", "$ equivalente de API por día"],
  "chart.axis.apiEquivalentPerWeek": ["$ API equivalent per week", "每周的 API 等价美元", "$ equivalente de API por semana"],
  "chart.axis.apiEquivalentPerInterval": ["$ API equivalent per interval", "每个间隔的 API 等价美元", "$ equivalente de API por intervalo"],
  "chart.axis.apiEquivalentPerSevenDays": ["$ API equivalent per seven-day allowance", "每个七天额度的 API 等价美元", "$ equivalente de API por asignación de siete días"],
  "chart.axis.sevenDayAllowanceRemaining": ["Seven-day allowance remaining (%)", "七天额度剩余（%）", "Asignación de siete días restante (%)"],
  "chart.series.apiEquivalentUsage": ["API-price-equivalent usage", "API 价格等价使用量", "Uso equivalente al precio de API"],
  "chart.series.sevenDayAllowanceRemaining": ["Seven-day allowance remaining", "七天额度剩余", "Asignación de siete días restante"],
  "chart.usage.title": ["Real local API-price-equivalent usage over time", "真实本地 API 价格等价使用量随时间变化", "Uso local real equivalente al precio de API a lo largo del tiempo"],
  "chart.usage.description": ["Local API-price-equivalent usage per {unit}, with the provider-observed seven-day allowance remaining on the right axis. Times are shown in {timeZone}.", "按{unit}显示的本地 API 价格等价使用量，右轴为提供方观测到的七天额度剩余。时间显示为 {timeZone}。", "Uso local equivalente al precio de API por {unit}, con la asignación de siete días restante observada por el proveedor en el eje derecho. Las horas se muestran en {timeZone}."],
  "chart.usage.heading": ["API-price-equivalent usage by {unit} · latest {range}", "按{unit}的 API 价格等价使用量 · 最近 {range}", "Uso equivalente al precio de API por {unit} · periodo reciente: {range}"],
  "chart.usage.aria": ["Interactive usage timeline in {timeZone}. Use plus or minus to zoom, arrow keys to pan, Home to reset, or drag horizontally.", "{timeZone} 的交互式使用情况时间线。使用加号或减号缩放，方向键平移，Home 重置，或水平拖动。", "Cronología interactiva de uso en {timeZone}. Usa más o menos para ampliar, las flechas para desplazar, Inicio para restablecer o arrastra horizontalmente."],
  "chart.unit.hour": ["hour", "小时", "hora"],
  "chart.unit.day": ["day", "天", "día"],
  "chart.unit.week": ["week", "周", "semana"],
  "chart.unit.interval": ["interval", "间隔", "intervalo"],
  "chart.residual.series": ["Residual", "残差", "Residuo"],
  "chart.residual.title": ["Quota movement residuals", "额度变化残差", "Residuos del movimiento de cuota"],
  "chart.residual.description": ["Observed quota change minus the API-cost-implied change, over the same date range as the calibration chart. Windows with no computable residual are left as shaded gaps. Times are shown in {timeZone}.", "观测到的额度变化减去按 API 成本推断的变化，日期范围与校准图相同。没有可计算残差的窗口保留为阴影缺口。时间显示为 {timeZone}。", "Cambio de cuota observado menos el cambio implícito por coste de API, en el mismo intervalo de fechas que el gráfico de calibración. Las ventanas sin residuo calculable quedan como huecos sombreados. Las horas se muestran en {timeZone}."],
  "chart.status.matched": ["Matched quota bracket", "匹配的额度区间", "Intervalo de cuota coincidente"],
  "chart.status.inactive": ["No local activity or quota movement", "没有本地活动或额度变化", "Sin actividad local ni movimiento de cuota"],
  "chart.status.unpricedLocalActivity": ["Usage change without reviewed price", "没有经审核价格的使用变化", "Cambio de uso sin precio revisado"],
  "chart.status.unexplainedWithoutLocalActivity": ["Quota movement without a local usage change", "没有本地使用变化的额度变动", "Movimiento de cuota sin cambio de uso local"],
  "chart.status.missingQuotaBracket": ["Quota bracket not recorded", "未记录额度区间", "Intervalo de cuota no registrado"],
  "chart.status.resetOrTrackChange": ["Window boundary or track change", "窗口边界或额度轨道变化", "Límite de ventana o cambio de seguimiento"],
  "chart.status.backwardOrAmbiguous": ["Movement needs context", "变化需要上下文", "El movimiento necesita contexto"],
  "chart.status.historical": ["Historical calibration point", "历史校准点", "Punto de calibración histórico"],

  // Weekly allowance history. The headline deliberately never follows the
  // chart controls, so its own copy has to say which population it summarizes
  // and how many of those estimates the chart is currently drawing.
  "weekly.headline.label": ["All-data median estimate", "全部数据的中位数估计", "Estimación mediana de todos los datos"],
  "weekly.headline.value": ["{amount} API equivalent", "{amount} API 等价值", "{amount} equivalente de API"],
  "weekly.headline.insufficient": ["Insufficient evidence", "证据不足", "Evidencia insuficiente"],
  "weekly.headline.range": ["80% across-reset range, all data: {lower}–{upper}", "全部数据的 80% 跨重置区间：{lower}–{upper}", "Intervalo del 80 % entre restablecimientos, todos los datos: {lower}–{upper}"],
  "weekly.headline.rangeUnavailable": ["No evidence interval available", "没有可用的证据区间", "No hay intervalo de evidencia disponible"],
  "weekly.headline.relationship": ["The headline is the median of all {qualifying} qualifying reset estimates and never moves with the controls below. The chart is currently drawing {shown} of {total} estimates: the selected range, with observed quota spans of {span}.", "标题为全部 {qualifying} 个合格重置估计的中位数，不会随下方控件变化。图表当前绘制 {total} 个估计中的 {shown} 个：所选范围，且观测额度跨度为{span}。", "El titular es la mediana de las {qualifying} estimaciones de restablecimiento válidas y nunca cambia con los controles de abajo. El gráfico dibuja actualmente {shown} de {total} estimaciones: el intervalo seleccionado, con intervalos de cuota observada de {span}."],
  "weekly.headline.pending": ["The estimate will appear when enough quota transitions can be matched to priced usage. The headline will then summarize all data, while the controls below filter only the chart.", "当有足够的额度变化可以与已定价的使用量匹配时，估计值就会出现。届时标题将汇总全部数据，而下方控件只会筛选图表。", "La estimación aparecerá cuando haya suficientes transiciones de cuota que puedan asociarse a uso con precio. Entonces el titular resumirá todos los datos, mientras que los controles de abajo solo filtran el gráfico."],
  "weekly.span.all": ["All spans", "全部跨度", "Todos los intervalos"],
  // The slider's own readout says "All spans"; a sentence has to say the same
  // setting as a phrase, not as a control label.
  "weekly.span.none": ["any length", "任意长度", "cualquier longitud"],
  "weekly.span.minimum": ["{span}+ pp", "{span}+ 个百分点", "{span}+ pp"],
  "weekly.series.allDataMedian": ["All-data median", "全部数据的中位数", "Mediana de todos los datos"],
  "weekly.series.allSpans": ["All observed spans", "全部观测跨度", "Todos los intervalos observados"],
  "weekly.series.wellObserved": ["Observed across {span}+ points", "跨 {span}+ 个点观测", "Observado en {span}+ puntos"],
  "weekly.series.shortObservation": ["Short observation", "观测跨度较短", "Observación corta"],
  "weekly.series.acrossResetRange": ["80% across-reset range", "80% 跨重置区间", "Intervalo del 80 % entre restablecimientos"],
  "weekly.series.measuredRange": ["Measured range", "测量区间", "Intervalo medido"],
  "weekly.point.detail": ["{span} observed · measured range {low}–{high}", "已观测 {span} · 测量区间 {low}–{high}", "{span} observado · intervalo medido {low}–{high}"],
  "weekly.chart.title": ["Seven-day allowance estimate history", "七天额度估计历史", "Historial de estimaciones de la asignación de siete días"],
  "weekly.chart.description": ["One estimate per observed seven-day reset, each with an observed quota span of {span}. The flat line is the all-data median that the headline reports. Measured ranges stay available on hover and focus. Times are shown in {timeZone}.", "每个观测到的七天重置对应一个估计，其观测额度跨度为{span}。水平线是标题所报告的全部数据中位数。测量区间在悬停和聚焦时仍可查看。时间显示为 {timeZone}。", "Una estimación por cada restablecimiento de siete días observado, cada una con un intervalo de cuota observada de {span}. La línea plana es la mediana de todos los datos que informa el titular. Los intervalos medidos siguen disponibles al pasar el cursor y al enfocar. Las horas se muestran en {timeZone}."],
  "weekly.chart.empty": ["No weekly estimates loaded.", "未加载每周估计。", "No se cargaron estimaciones semanales."],
  "weekly.table.empty": ["No weekly evidence loaded.", "未加载每周证据。", "No se cargó evidencia semanal."],
  "weekly.table.wellObserved": ["Well observed", "观测充分", "Bien observado"],
  "weekly.table.spanNotRecorded": ["Span not recorded", "未记录跨度", "Intervalo no registrado"],
  "residual.table.notComparable": ["Not comparable", "不可比较", "No comparable"],
  "residual.table.empty": ["No periods loaded.", "未加载任何时段。", "No se cargaron períodos."],
  "contribution.signInCancelled": ["{provider} sign-in was cancelled. Nothing was uploaded.", "已取消 {provider} 登录。未上传任何内容。", "Se canceló el inicio de sesión con {provider}. No se cargó nada."],
  "contribution.signInStarting": ["Starting {provider} sign-in…", "正在开始 {provider} 登录…", "Iniciando sesión con {provider}…"],
  "contribution.signInIncomplete": ["{provider} sign-in did not complete. Nothing was uploaded. You can try again.", "{provider} 登录未完成。未上传任何内容。你可以重试。", "El inicio de sesión con {provider} no se completó. No se cargó nada. Puedes intentarlo de nuevo."],
  "contribution.signInDiscarded": ["{message} For safety, this page discarded the one-time sign-in; sign in again before retrying.", "{message} 为安全起见，此页面已丢弃一次性登录；重试前请重新登录。", "{message} Por seguridad, esta página descartó el inicio de sesión de un solo uso; vuelve a iniciar sesión antes de reintentar."],
  "contribution.enrollmentPaused": ["New contribution enrollment is currently paused. Local reporting is unaffected.", "新的贡献注册目前已暂停。本地报告不受影响。", "La inscripción de nuevas contribuciones está actualmente en pausa. Los informes locales no se ven afectados."],
  "contribution.enrollmentPausedNoUpload": ["New contribution enrollment is currently paused. Local reporting is unaffected, and nothing was uploaded.", "新的贡献注册目前已暂停。本地报告不受影响，且未上传任何内容。", "La inscripción de nuevas contribuciones está actualmente en pausa. Los informes locales no se ven afectados y no se cargó nada."],
  "contribution.enrollmentPausedButton": ["New enrollment paused", "新的注册已暂停", "Nueva inscripción en pausa"],
  "contribution.newEnrollmentPausedSignInWorks": ["New sign-ups are paused. Contributed before? Signing in reconnects you.", "新用户注册已暂停。以前贡献过？登录即可重新连接。", "Las nuevas inscripciones están en pausa. ¿Ya contribuiste antes? Inicia sesión para reconectarte."],
  "contribution.identityGenericSession": ["Signed in for hosted contribution", "已登录以进行托管贡献", "Sesión iniciada para contribución alojada"],
  "contribution.signOutStarting": ["Signing out securely…", "正在安全退出登录…", "Cerrando sesión de forma segura…"],
  "contribution.signOutForgetting": ["Forgetting this unfinished sign-in…", "正在忘记这次未完成的登录…", "Olvidando este inicio de sesión incompleto…"],
  "contribution.signOutCompleted": ["Signed out. Sign in again with Google or Apple when you want to contribute.", "已退出登录。想继续贡献时，请使用 Google 或 Apple 再次登录。", "Sesión cerrada. Inicia sesión de nuevo con Google o Apple cuando quieras contribuir."],
  "contribution.signOutUnfinished": ["This unfinished sign-in was forgotten. No server session or metadata was created. Sign in again with Google or Apple when you want to contribute.", "这次未完成的登录已被忘记。没有创建服务器会话或元数据。想继续贡献时，请使用 Google 或 Apple 再次登录。", "Este inicio de sesión incompleto se olvidó. No se creó ninguna sesión de servidor ni metadatos. Inicia sesión de nuevo con Google o Apple cuando quieras contribuir."],
  "contribution.signOutFailed": ["The service could not confirm sign-out, so you are still signed in. Nothing was changed; check your connection and try again.", "服务无法确认退出登录，因此你仍处于登录状态。没有任何更改；请检查连接后重试。", "El servicio no pudo confirmar el cierre de sesión, por lo que sigues con la sesión iniciada. No se cambió nada; comprueba tu conexión e inténtalo de nuevo."],
  "share.period.allRetained": ["all retained evidence", "全部保留证据", "toda la evidencia conservada"],
  "share.period.cachedThirtyOneDay": ["the cached 31-day window", "缓存的 31 天窗口", "la ventana en caché de 31 días"],
  "share.period.cachedThirtyOneDayCollector": ["the cached 31-day collector window", "缓存的 31 天收集器窗口", "la ventana del recopilador en caché de 31 días"],
  "share.period.lastDay": ["the last 24 hours", "过去 24 小时", "las últimas 24 horas"],
  "share.period.lastThirtyDays": ["the last 30 days", "过去 30 天", "los últimos 30 días"],
  "share.period.lastSevenDays": ["the last 7 days", "过去 7 天", "los últimos 7 días"],
  "share.period.recorded": ["the recorded period", "记录的期间", "el período registrado"],
  "share.window.fiveHour": ["five-hour allowance", "五小时额度", "asignación de cinco horas"],
  "share.window.other": ["observed allowance window", "观测到的额度窗口", "ventana de asignación observada"],
  "share.window.providerReportedDuration": ["provider-reported {duration} window", "提供方报告的 {duration} 窗口", "ventana de {duration} informada por el proveedor"],
  "share.window.sevenDay": ["seven-day allowance", "七天额度", "asignación de siete días"],
  "share.stat.allowanceLeft": ["Allowance left", "剩余额度", "Asignación restante"],
  "share.stat.recordedActivity": ["Recorded activity", "记录的活动", "Actividad registrada"],
  "share.stat.estimatedAllowance": ["Estimated 7-day allowance", "估计的七天额度", "Asignación estimada de 7 días"],
  "share.stat.estimatedAllowanceUnavailable": ["7-day estimate", "7 天估计", "Estimación de 7 días"],
  "share.value.notObserved": ["Not observed", "未观测到", "No observado"],
  "share.value.notAvailable": ["Not available", "不可用", "No disponible"],
  "share.value.notEstimable": ["Not estimable", "无法估计", "No estimable"],
  "share.detail.noCurrentAllowance": ["no current allowance window was observed", "未观测到当前额度窗口", "no se observó una ventana de asignación actual"],
  "share.detail.ofWindow": ["of the {window}", "属于{window}", "de la {window}"],
  "share.detail.notApplicableToWindow": ["not calculated for this allowance window", "不针对该额度窗口计算", "no se calcula para esta ventana de asignación"],
  "share.detail.noPricedUsage": ["no priced usage was recorded", "未记录到已定价的使用量", "no se registró uso con precio"],
  "share.detail.activityPeriod": ["{period} · event-time API equivalent", "{period} · 按事件时间计算的 API 等价值", "{period} · equivalente de API en el momento del evento"],
  "share.detail.resetRange": ["Observed reset range {lower}–{upper}", "观测到的重置范围 {lower}–{upper}", "Rango de restablecimiento observado: {lower}–{upper}"],
  "share.detail.noAcrossResetRange": ["no across-reset range yet", "尚无跨重置范围", "aún no hay intervalo entre restablecimientos"],
  "share.detail.notEnoughMatchedWindows": ["not enough matched windows yet", "尚无足够的匹配窗口", "aún no hay suficientes ventanas coincidentes"],
  "share.relationship": ["Activity sums all events in {period}; the estimate is one seven-day allowance.", "活动汇总了{period}的全部事件；估计值是一份七天额度。", "La actividad suma todos los eventos de {period}; la estimación corresponde a una asignación de siete días."],
  "share.caveat.demo": ["Labeled demo data: an illustrative fixture, not measured usage.", "已标记的演示数据：示例性装置，不是测得的使用量。", "Datos de demostración etiquetados: una muestra ilustrativa, no uso medido."],
  "share.caveat.unweighted": ["Not a complete total: {amount} of Standard-rate cost could not be speed-weighted and is excluded rather than counted at 1x.", "不是完整总额：{amount} 的 Standard 费率成本无法按速度加权，因此被排除而不是按 1 倍计入。", "No es un total completo: {amount} de coste a tarifa Standard no pudo ponderarse por velocidad y se excluye en lugar de contarse a 1×."],
  "share.caveat.noWeighted": ["No usage could be speed-weighted, so this is the unchanged Standard-rate total.", "没有使用量可按速度加权，因此这是未变动的 Standard 费率总额。", "No se pudo ponderar ningún uso por velocidad, por lo que este es el total sin cambios a tarifa Standard."],
  "share.caveat.fastPartial": ["Fast-mode attribution is partial: Codex records the speed mode only when it changes, never at session start.", "Fast 模式归因不完整：Codex 仅在速度模式改变时记录，绝不会在会话开始时记录。", "La atribución del modo Fast es parcial: Codex registra el modo de velocidad solo cuando cambia, nunca al inicio de la sesión."],
  "share.caveat.coverage": ["{percent} of recorded usage changes have a reviewed public price; the remainder is omitted from the estimate.", "记录的使用变化中有 {percent} 具备经审核的公开价格；其余部分不纳入估算。", "El {percent} de los cambios de uso registrados tiene un precio público revisado; el resto queda fuera de la estimación."],
  "share.title": ["What my Codex allowance is really worth", "我的 Codex 额度到底值多少", "Lo que realmente vale mi asignación de Codex"],
  "share.subtitle.demo": ["Illustrative demo data. Not a measurement.", "示例性演示数据。不是测量结果。", "Datos de demostración ilustrativos. No son una medición."],
  "share.subtitle.local": ["Measured on my own Mac. Nothing left it.", "在我自己的 Mac 上测得。没有任何内容离开它。", "Medido en mi propio Mac. Nada salió de él."],
  "share.badge.demo": ["DEMO DATA", "演示数据", "DATOS DEMO"],
  "share.trend.label": ["7-day allowance estimates", "七天额度估计", "Estimaciones de asignación de 7 días"],
  "share.trend.empty": ["Not enough observed reset history yet.", "尚无足够的已观测重置历史。", "Aún no hay suficiente historial de restablecimientos observados."],
  "share.trend.emptyDetail": ["A completed reset becomes a point once enough of its allowance was observed.", "一旦观测到足够额度，完成的重置就会成为一个点。", "Un restablecimiento completado se convierte en un punto cuando se observa una parte suficiente de su asignación."],
  "share.trend.unavailableForWindow": ["No 7-day estimate for this allowance window.", "该额度窗口没有 7 天估计。", "No hay estimación de 7 días para esta ventana de asignación."],
  "share.trend.unavailableForWindowDetail": ["Reset-history estimates remain separate from provider-reported windows.", "重置历史估计与提供方报告的窗口保持分开。", "Las estimaciones del historial de restablecimientos se mantienen separadas de las ventanas informadas por el proveedor."],
  "share.axis.resetEstimateDate": ["Reset estimate date", "重置估计日期", "Fecha estimada de restablecimiento"],
  "share.axis.allowance": ["7-day allowance ($)", "七天额度（美元）", "Asignación de 7 días (USD)"],
  "share.identifier.debug": ["Debug: {reference}", "调试：{reference}", "Depuración: {reference}"],
  "share.identifier.unversioned": ["unversioned", "未版本化", "sin versión"],
  "share.identifier.version": ["v{version}", "v{version}", "v{version}"],
  "share.text.figure": ["{label}: {value} — {detail}.", "{label}：{value} — {detail}。", "{label}: {value} — {detail}."],
  "share.text.header": ["TiboTattle — {title}. {subtitle}", "TiboTattle — {title}。{subtitle}", "TiboTattle — {title}. {subtitle}"],
  "share.text.contract": ["{identifier} · contract {version}", "{identifier} · 契约 {version}", "{identifier} · contrato {version}"],
  "share.text.trailer": ["{trailer}.", "{trailer}。", "{trailer}."],
  "share.text.more": ["More at {home}", "更多信息：{home}", "Más en {home}"],
  "share.text.trendEmpty": ["{label}: {empty} {detail}", "{label}：{empty}{detail}", "{label}: {empty} {detail}"],
  "share.text.trendPopulated": ["{label}: {fits} observed from {start} to {end}. The vertical axis is API equivalent in dollars, spanning {low} to {high} including every measured range.", "{label}：从 {start} 到 {end} 观测到 {fits}。纵轴为美元 API 等价值，范围从 {low} 到 {high}，包含每个测得的区间。", "{label}: se observaron {fits} de {start} a {end}. El eje vertical es equivalente de API en dólares y abarca de {low} a {high}, incluidos todos los rangos medidos."],
  "format.unknown": ["Unknown", "未知", "Desconocido"],
  "format.unknownAge": ["Unknown age", "未知时间", "Antigüedad desconocida"],
  "format.lessThanTwoMinutes": ["Less than 2 minutes ago", "不到 2 分钟前", "Hace menos de 2 minutos"],
  "format.minutesAgo": ["{count} minutes ago", "{count} 分钟前", "Hace {count} minutos"],
  "format.hoursAgo": ["{count} hours ago", "{count} horas antes", "Hace {count} horas"],
  "format.daysAgo": ["{count} days ago", "{count} 天前", "Hace {count} días"],
  "format.timeUnavailable": ["Time remaining unavailable", "剩余时间不可用", "El tiempo restante no está disponible"],
  "format.resetDue": ["Reset due or recently passed", "重置时间已到或刚刚过去", "El restablecimiento vence o acaba de pasar"],
  "format.remainingDays": ["{days}d {hours}h remaining", "还剩 {days} 天 {hours} 小时", "Quedan {days} d {hours} h"],
  "format.remainingHours": ["{hours}h {minutes}m remaining", "还剩 {hours} 小时 {minutes} 分钟", "Quedan {hours} h {minutes} min"],
  "format.remainingMinutes": ["{minutes}m remaining", "还剩 {minutes} 分钟", "Quedan {minutes} min"],
  "action.cancel": ["Cancel", "取消", "Cancelar"],
  "action.cancelling": ["Cancelling…", "正在取消…", "Cancelando…"],
  "action.checkAgain": ["Check again", "再次检查", "Comprobar de nuevo"],
  "action.checkThisPageAgain": ["Check this page again", "再次检查此页面", "Comprobar esta página de nuevo"],
  "action.connecting": ["Connecting…", "正在连接…", "Conectando…"],
  "status.unknown": ["Unknown state", "未知状态", "Estado desconocido"],
  "aria.moreInformation": ["More information about {label}", "有关{label}的更多信息", "Más información sobre {label}"],
  "aria.tibotattleHome": ["TiboTattle home", "TiboTattle 主页", "Inicio de TiboTattle"],
  "aria.tibotattleDashboard": ["TiboTattle dashboard", "TiboTattle 仪表板", "Panel de TiboTattle"],
  "aria.dashboardNavigation": ["Dashboard navigation", "仪表板导航", "Navegación del panel"],
  "aria.dashboardSections": ["Dashboard sections", "仪表板分区", "Secciones del panel"],
  "aria.siteSections": ["Site sections", "网站分区", "Secciones del sitio"],
  "aria.releaseInformation": ["Release information", "发行信息", "Información de lanzamiento"],
  "aria.getTiboTattleForMac": ["Get TiboTattle for Mac", "获取适用于 Mac 的 TiboTattle", "Obtén TiboTattle para Mac"],
  "aria.tibotattleFeatures": ["What TiboTattle provides", "TiboTattle 提供的功能", "Qué ofrece TiboTattle"],
  "aria.findTiboTattleOnline": ["Find TiboTattle online", "在线查找 TiboTattle", "Encuentra TiboTattle en línea"],
  "aria.githubExternal": ["GitHub (opens in a new tab)", "GitHub（在新标签页中打开）", "GitHub (se abre en una pestaña nueva)"],
  "aria.xExternal": ["X (opens in a new tab)", "X（在新标签页中打开）", "X (se abre en una pestaña nueva)"],
  "alt.previewWeeklyHistory": ["Sample seven-day allowance history with reset-level uncertainty ranges", "带有重置级别不确定性范围的七天额度历史示例", "Ejemplo de historial de asignación de siete días con intervalos de incertidumbre por restablecimiento"],
  "aria.shareCard": ["A results card is generated once local evidence is available.", "本地证据可用后会生成结果卡片。", "Se genera una tarjeta de resultados cuando hay evidencia local disponible."],
  "aria.weeklyHistoryRange": ["Weekly history date range", "每周历史日期范围", "Intervalo de fechas del historial semanal"],
  "aria.weeklyEstimateLegend": ["Weekly estimate chart legend", "每周估计图例", "Leyenda del gráfico de estimación semanal"],
  "aria.usageGrouping": ["Usage grouping", "使用情况分组", "Agrupación de uso"],
  "aria.usageDateRange": ["Usage chart date range", "使用图日期范围", "Intervalo de fechas del gráfico de uso"],
  "aria.usageLegend": ["Usage chart legend", "使用图图例", "Leyenda del gráfico de uso"],
  "aria.usageZoomPan": ["Usage zoom and pan", "使用情况缩放和平移", "Zoom y desplazamiento de uso"],
  "aria.calibrationWindow": ["Calibration rolling comparison window", "校准滚动比较窗口", "Ventana de comparación móvil de calibración"],
  "aria.calibrationDateRange": ["Calibration date range", "校准日期范围", "Intervalo de fechas de calibración"],
  "aria.calibrationZoomPan": ["Calibration zoom and pan", "校准缩放和平移", "Zoom y desplazamiento de calibración"],
  "aria.calibrationLegend": ["Calibration chart legend", "校准图图例", "Leyenda del gráfico de calibración"],
  "aria.accountingPeriod": ["Accounting period", "核算期间", "Período contable"],
  "aria.contributionLookback": ["Contribution preparation lookback", "贡献准备回溯范围", "Período retrospectivo de preparación de contribución"],
  "aria.foregroundContributionControls": ["Foreground contribution controls", "前台贡献控制", "Controles de contribución en primer plano"],
  "aria.contributionJourney": ["Contribution journey stages", "贡献流程阶段", "Etapas del recorrido de contribución"],
  "journey.state.done": ["Done", "已完成", "Hecho"],
  "journey.state.inProgress": ["In progress", "进行中", "En curso"],
  "journey.state.actionNeeded": ["Action needed", "需要操作", "Acción necesaria"],
  "journey.state.waiting": ["Waiting", "等待中", "En espera"],
  "journey.app.connected": [
    "The TiboTattle companion on this Mac is answering.",
    "这台 Mac 上的 TiboTattle 伴随程序正在响应。",
    "El acompañante de TiboTattle en este Mac está respondiendo.",
  ],
  "journey.app.missing": [
    "Open TiboTattle from Applications and use its in-app window.",
    "请从“应用程序”打开 TiboTattle，并使用其应用内窗口。",
    "Abre TiboTattle desde Aplicaciones y usa su ventana integrada.",
  ],
  "journey.index.complete": [
    "The discovered history is fully indexed.",
    "已发现的历史记录已全部编入索引。",
    "El historial descubierto está completamente indexado.",
  ],
  "journey.index.waiting": [
    "Waiting for the first local analysis.",
    "正在等待第一次本地分析。",
    "A la espera del primer análisis local.",
  ],
  "journey.evidence.ready": [
    "Latest observation {time}.",
    "最新观测：{time}。",
    "Última observación: {time}.",
  ],
  "journey.evidence.demo": [
    "Labeled demo figures, not your usage.",
    "这是带标注的演示数据，不是你的使用情况。",
    "Cifras de demostración etiquetadas, no tu uso.",
  ],
  "journey.evidence.missing": [
    "Analyze local usage to build evidence.",
    "请分析本地使用情况以建立证据。",
    "Analiza el uso local para generar evidencia.",
  ],
  "journey.community.waitingCompanion": [
    "Waiting for the Mac app and its companion first.",
    "请先等待 Mac 应用及其伴随程序。",
    "Primero se espera la app para Mac y su acompañante.",
  ],
  "journey.community.noService": [
    "This build has no contribution service, so nothing can be sent. Local review still works.",
    "此构建没有贡献服务，因此无法发送任何内容。本地审阅仍然可用。",
    "Esta compilación no tiene servicio de contribución, así que no se puede enviar nada. La revisión local sigue funcionando.",
  ],
  "journey.community.paused": [
    "New community sign-ups are paused. Nothing can be sent.",
    "社区新注册已暂停。无法发送任何内容。",
    "Las nuevas inscripciones a la comunidad están en pausa. No se puede enviar nada.",
  ],
  "journey.community.signInFirst": [
    "Sign in with Google or Apple below before anything else. Send stays off without it.",
    "请先在下方使用 Google 或 Apple 登录。未登录时“发送”保持关闭。",
    "Primero inicia sesión abajo con Google o Apple. Enviar permanece desactivado sin ello.",
  ],
  "journey.community.connectNext": [
    "Signed in. Connect this Mac below as an upload-only device.",
    "已登录。请在下方将这台 Mac 连接为仅上传设备。",
    "Sesión iniciada. Conecta este Mac abajo como dispositivo solo de carga.",
  ],
  "journey.community.connected": [
    "Connected. A prepared summary verifies below, then you decide whether to send it.",
    "已连接。准备好的摘要将在下方完成校验，然后由你决定是否发送。",
    "Conectado. El resumen preparado se verifica abajo y tú decides si enviarlo.",
  ],
  "syncGate.signInFirst": [
    "Sign in at the top of this section first. Nothing can send without it.",
    "请先在本区域顶部登录。未登录时无法发送任何内容。",
    "Primero inicia sesión en la parte superior de esta sección. Sin ello no se puede enviar nada.",
  ],
  "syncGate.connectFirst": [
    "Connect this Mac at the top of this section first. Nothing can send without it.",
    "请先在本区域顶部连接这台 Mac。未连接时无法发送任何内容。",
    "Primero conecta este Mac en la parte superior de esta sección. Sin ello no se puede enviar nada.",
  ],
  "syncGate.prepareFirst": [
    "Prepare a summary above first. Nothing is selected to send.",
    "请先在上方准备一份摘要。尚未选择要发送的内容。",
    "Primero prepara un resumen arriba. No hay nada seleccionado para enviar.",
  ],
  "syncGate.notConfigured": [
    "This build has no contribution delivery configured, so there is nothing to send.",
    "此构建未配置贡献投递，因此没有可发送的内容。",
    "Esta compilación no tiene configurada la entrega de contribuciones, así que no hay nada que enviar.",
  ],
  "syncGate.verifying": [
    "Verifying this exact summary on this Mac…",
    "正在这台 Mac 上校验这份摘要…",
    "Verificando este resumen exacto en este Mac…",
  ],
  "syncGate.paused": [
    "Delivery is paused on this Mac. Nothing sends until it is resumed.",
    "这台 Mac 上的投递已暂停。恢复之前不会发送任何内容。",
    "La entrega está en pausa en este Mac. No se envía nada hasta reanudarla.",
  ],
  "syncState.readyToSend": [
    "Verified · ready to send",
    "已校验 · 可发送",
    "Verificado · listo para enviar",
  ],
  "syncState.verifying": ["Verifying…", "正在校验…", "Verificando…"],
  "syncState.verifiedLocalOnly": [
    "Verified locally",
    "已在本地校验",
    "Verificado localmente",
  ],
  "syncState.awaitingVerification": [
    "Prepared · not verified",
    "已准备 · 未校验",
    "Preparado · sin verificar",
  ],
  "syncStatus.verifyingSummary": [
    "Verifying the prepared summary on this Mac. Nothing is sent while it is checked.",
    "正在这台 Mac 上校验已准备的摘要。检查期间不会发送任何内容。",
    "Verificando el resumen preparado en este Mac. No se envía nada mientras se comprueba.",
  ],
  "syncStatus.summaryVerified": [
    "The exact summary above is verified on this Mac. Nothing sends unless you press Send.",
    "上方的确切摘要已在这台 Mac 上完成校验。除非你按下“发送”，否则不会发送任何内容。",
    "El resumen exacto de arriba está verificado en este Mac. No se envía nada a menos que pulses Enviar.",
  ],
  "prepareGate.signInFirst": [
    "Sign in and connect this Mac above first, so nothing you prepare can hit a sign-in wall at send time.",
    "请先在上方登录并连接这台 Mac，这样你准备的内容在发送时才不会被登录要求拦住。",
    "Primero inicia sesión y conecta este Mac arriba, para que nada de lo que prepares choque con un muro de inicio de sesión al enviar.",
  ],
  "prepareGate.connectFirst": [
    "Connect this Mac above first. Preparing stays local, and this order means Send cannot fail afterwards for a missing connection.",
    "请先在上方连接这台 Mac。准备仍然在本地进行；这一顺序保证“发送”不会在之后因缺少连接而失败。",
    "Primero conecta este Mac arriba. La preparación sigue siendo local, y este orden evita que Enviar falle después por falta de conexión.",
  ],
  "consent.reviewFirst": [
    "Review one prepared summary below first: you approve the kind of data by seeing one real instance of it.",
    "请先在下方审阅一份已准备的摘要：你通过查看一个真实实例来核准这种数据类型。",
    "Primero revisa un resumen preparado abajo: apruebas el tipo de datos viendo una instancia real.",
  ],
  "consent.readyToApprove": [
    "A verified summary is ready below. Approving covers this kind of data from now on.",
    "下方已有一份经校验的摘要。核准后即涵盖今后同类数据。",
    "Hay un resumen verificado abajo. Aprobar cubre este tipo de datos de ahora en adelante.",
  ],
  "consent.approving": [
    "Recording your approval on this Mac…",
    "正在这台 Mac 上记录你的核准…",
    "Registrando tu aprobación en este Mac…",
  ],
  "consent.approved": [
    "Approved. Uploads run and recompute the community estimates; only a change to the kind of data or the destination asks again.",
    "已核准。上传将运行并重新计算社区估计；只有数据类型或目的地发生变化时才会再次询问。",
    "Aprobado. Las cargas se ejecutan y recalculan las estimaciones comunitarias; solo un cambio en el tipo de datos o el destino vuelve a preguntar.",
  ],
  "consent.stateApproved": ["Approved", "已核准", "Aprobado"],
  "consent.stateNotApproved": ["Not approved", "未核准", "No aprobado"],
  "title.panCalibrationEarlier": ["Pan calibration earlier", "向前平移校准", "Desplazar la calibración hacia antes"],
  "title.zoomOut": ["Zoom out", "缩小", "Alejar"],
  "title.zoomIn": ["Zoom in", "放大", "Acercar"],
  "title.panCalibrationLater": ["Pan calibration later", "向后平移校准", "Desplazar la calibración hacia después"],
  "title.panUsageEarlier": ["Pan usage earlier", "向前平移使用情况", "Desplazar el uso hacia antes"],
  "title.panUsageLater": ["Pan usage later", "向后平移使用情况", "Desplazar el uso hacia después"],
  "installer.version": ["Version {version}", "版本 {version}", "Versión {version}"],
  "installer.requiresMacOS": ["Requires macOS {version} or later · {architecture}", "需要 macOS {version} 或更高版本 · {architecture}", "Requiere macOS {version} o posterior · {architecture}"],
  "installer.downloadKiB": ["{value} KiB download", "下载 {value} KiB", "Descarga de {value} KiB"],
  "installer.downloadMiB": ["{value} MiB download", "下载 {value} MiB", "Descarga de {value} MiB"],
  "installer.sha256": ["SHA-256 {value}", "SHA-256 {value}", "SHA-256 {value}"],
  "installer.appleSilicon": ["Apple silicon", "Apple 芯片", "Apple Silicon"],
  "installer.intel": ["Intel", "Intel", "Intel"],
  "installer.appleSiliconAndIntel": ["Apple silicon and Intel", "Apple 芯片和 Intel", "Apple Silicon e Intel"],
  "community.snapshotTitle": ["Community activity snapshot", "社区活动快照", "Resumen de actividad comunitaria"],
  "community.snapshotUnavailable": ["Snapshot temporarily unavailable", "快照暂时不可用", "Resumen temporalmente no disponible"],
  "community.snapshotAvailable": ["Snapshot available", "快照可用", "Resumen disponible"],
  "community.snapshotPartlyAvailable": ["Snapshot partly available", "快照部分可用", "Resumen parcialmente disponible"],
  "community.noSnapshotPublished": ["No snapshot published yet", "尚未发布快照", "Aún no se ha publicado ningún resumen"],
  "community.snapshotWithdrawn": ["Snapshot withdrawn", "快照已撤回", "Resumen retirado"],
  "community.noSnapshotReleased": ["No snapshot released for this period", "此期间未发布快照", "No se publicó ningún resumen para este período"],
  "community.snapshotUnavailableShort": ["Snapshot unavailable", "快照不可用", "Resumen no disponible"],
  "community.failedLoad": ["The published snapshot could not be loaded. Nothing is inferred from a failed request.", "无法加载已发布的快照。失败的请求不会推断任何结果。", "No se pudo cargar el resumen publicado. No se infiere nada de una solicitud fallida."],
  "community.reportedCause": ["Reported cause: {code}.", "报告原因：{code}。", "Causa informada: {code}."],
  "community.serviceReference": ["Service reference {reference}.", "服务参考：{reference}。", "Referencia del servicio {reference}."],
  "community.state.serviceUnavailable": ["Community activity is temporarily unavailable. This does not tell us whether a weekly snapshot exists.", "中心服务不可用。这并不能说明每周快照是否存在。", "La actividad de la comunidad no está disponible temporalmente. Esto no indica si existe un resumen semanal."],
  "community.state.developmentUnsafe": ["No public community snapshot is available for this response.", "此响应没有可用的公开社区快照。", "No hay ningún resumen comunitario público disponible para esta respuesta."],
  "community.state.unsupportedSchema": ["This community snapshot cannot be displayed safely with this version of TiboTattle.", "此版本的 TiboTattle 无法安全显示这个社区快照。", "Este resumen comunitario no se puede mostrar de forma segura con esta versión de TiboTattle."],
  "community.state.notYetPublished": ["No stable weekly snapshot is available yet.", "尚无稳定的每周快照可用。", "Todavía no hay un resumen semanal estable disponible."],
  "community.state.withdrawn": ["This snapshot is no longer available. A replacement snapshot may be pending.", "此快照已不再可用。替代快照可能仍在等待中。", "Este resumen ya no está disponible. Puede haber un resumen de reemplazo pendiente."],
  "community.state.suppressed": ["No public snapshot is available for this period.", "此期间没有可用的公开快照。", "No hay ningún resumen público disponible para este período."],
  "community.pending.releasedSnapshot": ["Released snapshot", "已发布快照", "Resumen publicado"],
  "community.pending.notLoaded": ["Not loaded", "未加载", "No cargado"],
  "community.pending.cohortLimit": ["Additional activity context", "其他活动上下文", "Contexto adicional de actividad"],
  "community.pending.matchedQuota": ["Additional activity context", "其他活动上下文", "Contexto adicional de actividad"],
  "community.pending.changeConfidence": ["Snapshot context", "快照上下文", "Contexto del resumen"],
  "community.pending.notInContract": ["Not in current contract", "不在当前契约中", "No está en el contrato actual"],
  "community.noCapacityClaim": ["This page shows delayed, aggregate activity only. It does not turn those totals into a personal reading or a statement about everyone.", "本页只显示延迟的汇总活动。这些总量不会被转换为个人读数或关于所有人的结论。", "Esta página solo muestra actividad agregada y diferida. Estos totales no se convierten en una lectura personal ni en una afirmación sobre todo el mundo."],
  "community.weeklyActivity": ["Delayed aggregate activity totals for the period above come from people who chose to contribute. A figure appears only when at least {count} different participants used that provider and model, and every figure is rounded down — so this is not everyone's usage, an average, a cost, or a personal reading.", "以上期间的延迟汇总活动总量来自选择贡献的人。只有当至少 {count} 位不同参与者使用了该提供商和模型时才会显示数值，并且所有数值都会向下取整——因此这不是每个人的使用情况、平均值、成本或个人读数。", "Los totales de actividad agregada y diferida del período anterior proceden de personas que eligieron contribuir. Una cifra aparece solo cuando al menos {count} participantes diferentes usaron ese proveedor y modelo, y todas las cifras se redondean hacia abajo; por tanto, no es el uso de todas las personas, un promedio, un coste ni una lectura personal."],
  "community.partialMetrics": ["Some metrics were not released because their independent support was insufficient.", "部分指标因独立支持不足而未发布。", "Algunas métricas no se publicaron porque su soporte independiente fue insuficiente."],
  "community.providerAccountWeeklyActivity": ["Delayed aggregate activity totals for the period above come from eligible contribution accounts. A figure appears only when at least {count} distinct eligible social-provider accounts used that provider and model, and every figure is rounded down — so this is not everyone's usage, an average, a cost, or a personal reading.", "以上期间的延迟汇总活动总量来自符合条件的贡献账户。只有当至少 {count} 个不同的符合条件的社交提供商账户使用了该提供商和模型时才会显示数值，并且所有数值都会向下取整——因此这不是每个人的使用情况、平均值、成本或个人读数。", "Los totales de actividad agregada y diferida del período anterior proceden de cuentas de contribución elegibles. Una cifra aparece solo cuando al menos {count} cuentas elegibles y distintas de proveedores sociales usaron ese proveedor y modelo, y todas las cifras se redondean hacia abajo; por tanto, no es el uso de todas las personas, un promedio, un coste ni una lectura personal."],
  "community.providerAccountPartialMetrics": ["Some metrics were not released because the eligible provider-account cohort did not meet the publication threshold.", "部分指标未发布，因为符合条件的提供商账户群组未达到发布门槛。", "Algunas métricas no se publicaron porque la cohorte de cuentas de proveedor elegibles no alcanzó el umbral de publicación."],
  "community.contract": ["Contract", "契约", "Contrato"],
  "community.releasedModelCells": ["Released model cells", "已发布模型单元格", "Celdas de modelo publicadas"],
  "community.minimumSupport": ["Minimum support", "最低支持", "Soporte mínimo"],
  "community.participantsPerCell": ["≥{count} participants per cell", "每个单元格 ≥{count} 位参与者", "≥{count} participantes por celda"],
  "community.providerAccountsPerCell": ["≥{count} eligible provider accounts per cell", "每个单元格 ≥{count} 个符合条件的提供商账户", "≥{count} cuentas de proveedor elegibles por celda"],
  "community.ingestionCutoff": ["Ingestion cutoff", "摄取截止时间", "Corte de ingesta"],
  "community.released": ["Released", "已发布", "Publicado"],
  "community.snapshotAge": ["Snapshot age", "快照时长", "Antigüedad del resumen"],
  "community.coverageState": ["Coverage state", "覆盖状态", "Estado de cobertura"],
  "community.partiallyReleased": ["Partially released", "部分发布", "Publicado parcialmente"],
  "community.allContractedCells": ["All contracted cells released", "所有契约单元格均已发布", "Todas las celdas contratadas publicadas"],
  "community.releaseMechanics": ["Each value is clipped per participant, independently support-gated at {count} or more participants, and rounded down. A sealed revision is never rewritten; deletion creates a replacement revision.", "每个数值都会按参与者截断，在 {count} 位或更多参与者的独立支持门槛下发布，并向下取整。已封存修订绝不会被重写；删除会创建替代修订。", "Cada valor se recorta por participante, está sujeto de forma independiente a un umbral de soporte de {count} o más participantes y se redondea hacia abajo. Una revisión sellada nunca se reescribe; la eliminación crea una revisión de reemplazo."],
  "community.providerAccountReleaseMechanics": ["Each value is capped per eligible provider account, published only when {count} or more eligible accounts support the cell, and rounded down. The social-login gate resists trivial replay; it is not a claim that every account is an independently verified person. A sealed revision is never rewritten; deletion creates a replacement revision.", "每个数值都会按符合条件的提供商账户封顶，只有当至少 {count} 个符合条件的账户支持该单元格时才会发布，并向下取整。社交登录门槛可防止简单重放；它并不声称每个账户都是经过独立验证的人。已封存修订绝不会被重写；删除会创建替代修订。", "Cada valor se limita por cuenta de proveedor elegible, se publica solo cuando {count} o más cuentas elegibles respaldan la celda y se redondea hacia abajo. La puerta de inicio de sesión social resiste la repetición trivial; no afirma que cada cuenta sea una persona verificada de forma independiente. Una revisión sellada nunca se reescribe; la eliminación crea una revisión de reemplazo."],
  "community.currentReleaseScope": ["This release reports delayed, aggregate activity totals only. It does not turn them into a personal reading or a statement about everyone.", "此版本只报告延迟的汇总活动总量。它不会将这些总量转换为个人读数或关于所有人的结论。", "Esta versión solo informa de totales de actividad agregada y diferida. No los convierte en una lectura personal ni en una afirmación sobre todo el mundo."],
  "community.estimate.serviceUnavailable.label": ["Unavailable", "不可用", "No disponible"],
  "community.estimate.serviceUnavailable.hero": ["Unavailable right now", "当前不可用", "No disponible ahora"],
  "community.estimate.serviceUnavailable.body": ["The community activity service is temporarily unavailable, so there’s no snapshot to show.", "社区活动服务暂时不可用，因此没有可显示的快照。", "El servicio de actividad comunitaria no está disponible temporalmente, por lo que no hay ningún resumen que mostrar."],
  "community.estimate.developmentUnsafe.label": ["Unavailable", "不可用", "No disponible"],
  "community.estimate.developmentUnsafe.hero": ["No public snapshot", "没有公开快照", "No hay resumen público"],
  "community.estimate.developmentUnsafe.body": ["There’s no public community activity snapshot to show right now.", "目前没有可显示的公开社区活动快照。", "Ahora no hay ningún resumen público de actividad comunitaria que mostrar."],
  "community.estimate.unsupportedSchema.label": ["Unavailable", "不可用", "No disponible"],
  "community.estimate.unsupportedSchema.hero": ["Snapshot update required", "需要更新快照", "Se requiere actualizar el resumen"],
  "community.estimate.unsupportedSchema.body": ["This snapshot needs an update before it can be shown.", "此快照需要更新后才能显示。", "Este resumen necesita una actualización antes de poder mostrarse."],
  "community.estimate.notYetPublished.label": ["Collecting evidence", "正在收集证据", "Recopilando evidencia"],
  "community.estimate.notYetPublished.hero": ["Waiting for a snapshot", "正在等待快照", "Esperando un resumen"],
  "community.estimate.notYetPublished.body": ["A public community activity snapshot has not been published yet.", "公开社区活动快照尚未发布。", "Todavía no se ha publicado ningún resumen público de actividad comunitaria."],
  "community.estimate.withdrawn.label": ["Not published", "未发布", "No publicado"],
  "community.estimate.withdrawn.hero": ["Snapshot unavailable", "快照不可用", "Resumen no disponible"],
  "community.estimate.withdrawn.body": ["This community activity snapshot is no longer available.", "此社区活动快照已不再可用。", "Este resumen de actividad comunitaria ya no está disponible."],
  "community.estimate.suppressed.label": ["Not published", "未发布", "No publicado"],
  "community.estimate.suppressed.hero": ["No snapshot for this period", "此期间没有快照", "No hay resumen para este período"],
  "community.estimate.suppressed.body": ["No public community activity snapshot is available for this period.", "此期间没有可用的公开社区活动快照。", "No hay ningún resumen público de actividad comunitaria disponible para este período."],
  "community.estimate.activityOnly.label": ["Activity only", "仅活动", "Solo actividad"],
  "community.estimate.activityOnly.hero": ["Activity snapshot available", "活动快照可用", "Resumen de actividad disponible"],
  "community.estimate.activityOnly.body": ["Delayed community activity is shown as an aggregate snapshot only.", "延迟的社区活动仅作为汇总快照显示。", "La actividad comunitaria diferida se muestra únicamente como un resumen agregado."],
  "community.detailedActivity": ["View detailed activity by provider and model ({count} cells)", "按提供商和模型查看详细活动（{count} 个单元格）", "Ver actividad detallada por proveedor y modelo ({count} celdas)"],
  "community.metricsCaption": ["Delayed weekly community activity metrics", "延迟的每周社区活动指标", "Métricas diferidas de actividad comunitaria semanal"],
  "community.providerModel": ["Provider / model", "提供商 / 模型", "Proveedor / modelo"],
  "community.planUnknown": ["plan unknown", "套餐未知", "plan desconocido"],
  "community.notReleased": ["Not released", "未发布", "No publicado"],
  "community.metric.usageEvents": ["Usage events", "使用事件", "Eventos de uso"],
  "community.metric.inputUncached": ["Input uncached", "未缓存输入", "Entrada sin caché"],
  "community.metric.cacheRead": ["Cache read", "缓存读取", "Lectura de caché"],
  "community.metric.cacheWrite": ["Cache write", "缓存写入", "Escritura de caché"],
  "community.metric.outputText": ["Output text", "文本输出", "Salida de texto"],
  "community.metric.reasoningOutput": ["Reasoning output", "推理输出", "Salida de razonamiento"],
  "community.metric.combinedOutput": ["Combined output", "合并输出", "Salida combinada"],
  "community.metric.toolUnits": ["Tool units", "工具单位", "Unidades de herramientas"],
});

function catalogIndex(locale) {
  return SUPPORTED_LOCALES.indexOf(locale);
}

/**
 * Catalog column per already-seen locale request.
 *
 * `negotiateLocale` is the full BCP 47 negotiation: it normalizes the
 * supported list, canonicalizes a fallback, and walks the requested values
 * through script and region matching. That is the right amount of work to do
 * once for a locale, and the wrong amount to do per string. `translate` ran it
 * on every call, and `translate` is called several times per plotted chart
 * point, so the calibration panel spent about 13.5 microseconds per string
 * doing negotiation it had already done - measured in the live page at 13.51
 * against a 0.005 loop baseline, roughly 10 ms per frame at the default range.
 *
 * A locale negotiates to the same column every time, so the answer is
 * remembered. Only the resolved index is cached, never a rendered string, so
 * interpolation still runs per call and nothing about the catalog changes.
 */
const catalogIndexByRequest = new Map();

function negotiatedCatalogIndex(locale) {
  const key = typeof locale === "string" ? locale : JSON.stringify(locale);
  const remembered = catalogIndexByRequest.get(key);
  if (remembered !== undefined) return remembered;
  const index = catalogIndex(negotiateLocale(locale));
  catalogIndexByRequest.set(key, index);
  return index;
}

export function translate(key, values = {}, locale = DEFAULT_LOCALE) {
  const row = WEB_MESSAGES[key];
  if (!row) return interpolate(key, values);
  const index = negotiatedCatalogIndex(locale);
  return interpolate(row[index < 0 ? 0 : index], values);
}

// Plural forms stay small and standards-based. This is deliberately not a
// second runtime or an ICU parser: the browser already provides the locale's
// plural category through Intl.PluralRules, while catalog entries retain the
// same locale-column convention as WEB_MESSAGES.
export const WEB_PLURAL_MESSAGES = Object.freeze({
  "dashboard.timeline.window": Object.freeze({
    one: ["{count} matched quota window", "{count} 个匹配额度窗口", "{count} ventana de cuota coincidente"],
    other: ["{count} matched quota windows", "{count} 个匹配额度窗口", "{count} ventanas de cuota coincidentes"],
  }),
  "dashboard.timeline.visibleWindow": Object.freeze({
    one: ["{count} matched quota window is visible", "可见 {count} 个匹配额度窗口", "se ve {count} ventana de cuota coincidente"],
    other: ["{count} matched quota windows are visible", "可见 {count} 个匹配额度窗口", "se ven {count} ventanas de cuota coincidentes"],
  }),
  "dashboard.timeline.shownWindow": Object.freeze({
    one: ["{count} matched quota window is shown", "显示了 {count} 个匹配额度窗口", "se muestra {count} ventana de cuota coincidente"],
    other: ["{count} matched quota windows are shown", "显示了 {count} 个匹配额度窗口", "se muestran {count} ventanas de cuota coincidentes"],
  }),
  "dashboard.timeline.excludedWindow": Object.freeze({
    one: ["{count} window is excluded for missing or ambiguous quota evidence", "有 {count} 个窗口因缺少或不明确的额度证据而被排除", "{count} ventana está excluida por evidencia de cuota ausente o ambigua"],
    other: ["{count} windows are excluded for missing or ambiguous quota evidence", "有 {count} 个窗口因缺少或不明确的额度证据而被排除", "{count} ventanas están excluidas por evidencia de cuota ausente o ambigua"],
  }),
  "dashboard.timeline.series": Object.freeze({
    one: ["No {window} series loaded", "未加载 {window} 序列", "No se cargó ninguna serie de {window}"],
    other: ["No {window} series loaded", "未加载 {window} 序列", "No se cargó ninguna serie de {window}"],
  }),
  "dashboard.residual.window": Object.freeze({
    one: ["{count} window", "{count} 个窗口", "{count} ventana"],
    other: ["{count} windows", "{count} 个窗口", "{count} ventanas"],
  }),
  "dashboard.residual.allComputable": Object.freeze({
    one: ["The {count} window in this range has a computable residual.", "此范围内的 {count} 个窗口有可计算的残差。", "La {count} ventana de este intervalo tiene un residual calculable."],
    other: ["All {count} windows in this range have a computable residual.", "此范围内的全部 {count} 个窗口都有可计算的残差。", "Todas las {count} ventanas de este intervalo tienen un residual calculable."],
  }),
  "contribution.deduplicatedRecord": Object.freeze({
    one: ["{count} deduplicated record", "{count} 条去重记录", "{count} registro deduplicado"],
    other: ["{count} deduplicated records", "{count} 条去重记录", "{count} registros deduplicados"],
  }),
  "contribution.batch": Object.freeze({
    one: ["{count} contribution batch", "{count} 个贡献批次", "{count} lote de contribución"],
    other: ["{count} contribution batches", "{count} 个贡献批次", "{count} lotes de contribución"],
  }),
  "format.durationMinute": Object.freeze({
    one: ["{count} minute", "{count} 分钟", "{count} minuto"],
    other: ["{count} minutes", "{count} 分钟", "{count} minutos"],
  }),
  "format.durationHour": Object.freeze({
    one: ["{count} hour", "{count} 小时", "{count} hora"],
    other: ["{count} hours", "{count} 小时", "{count} horas"],
  }),
  "format.durationDay": Object.freeze({
    one: ["{count} day", "{count} 天", "{count} día"],
    other: ["{count} days", "{count} 天", "{count} días"],
  }),
  "quota.durationMinute": Object.freeze({
    one: ["{count}-minute", "{count} 分钟", "{count} minuto"],
    other: ["{count}-minute", "{count} 分钟", "{count} minutos"],
  }),
  "quota.durationHour": Object.freeze({
    one: ["{count}-hour", "{count} 小时", "{count} hora"],
    other: ["{count}-hour", "{count} 小时", "{count} horas"],
  }),
  "quota.durationDay": Object.freeze({
    one: ["{count}-day", "{count} 天", "{count} día"],
    other: ["{count}-day", "{count} 天", "{count} días"],
  }),
  "share.resetFit": Object.freeze({
    one: ["{count} reset fit", "{count} 个重置拟合", "{count} ajuste de restablecimiento"],
    other: ["{count} reset fits", "{count} 个重置拟合", "{count} ajustes de restablecimiento"],
  }),
});

export function translatePlural(
  key,
  count,
  values = {},
  locale = DEFAULT_LOCALE,
) {
  const row = WEB_PLURAL_MESSAGES[key];
  const resolvedLocale = negotiateLocale(locale);
  const safeCount = typeof count === "number" && Number.isFinite(count)
    ? count
    : 0;
  if (!row) return interpolate(key, { ...values, count: safeCount });
  const category = new Intl.PluralRules(resolvedLocale).select(safeCount);
  const form = row[category] ?? row.other;
  const index = catalogIndex(resolvedLocale);
  return interpolate(form[index < 0 ? 0 : index], {
    count: safeCount,
    ...values,
  });
}

/**
 * Test-only pseudo-localization used to stress text expansion and ensure
 * placeholders remain intact. It is not a selectable product locale.
 */
export function pseudoLocalize(value) {
  const protectedTokens = [];
  const protectedValue = String(value).replace(
    /\{[A-Za-z][A-Za-z0-9_.-]*\}/gu,
    (token) => {
      protectedTokens.push(token);
      return `\u0000${protectedTokens.length - 1}\u0000`;
    },
  );
  const accents = Object.freeze({
    a: "à", e: "ë", i: "ï", o: "ô", u: "ü",
    A: "À", E: "Ë", I: "Ï", O: "Ô", U: "Ü",
  });
  const expanded = protectedValue.replace(/[AEIOUaeiou]/gu, (letter) =>
    `${accents[letter] ?? letter}${letter}`,
  );
  return `［${expanded.replace(/\u0000(\d+)\u0000/gu, (_, index) =>
    protectedTokens[Number(index)]
  )}］`;
}

// Exact text-node translations are intentionally a migration bridge. They let
// the existing server-rendered dashboard become localized without injecting
// strings as HTML or changing user/provider data. The static-page inventory
// test keeps this catalog complete for both shipped HTML entry points; new DOM
// code should instead use a semantic `t` key above.
export const LEGACY_TEXT_CATALOG = Object.freeze({
  // The community guided journey: stage names, the collapsed review card, and
  // the approve-once incremental consent surface.
  "Mac app & companion": ["Mac 应用与伴随程序", "App para Mac y acompañante"],
  "Local usage index": ["本地使用索引", "Índice de uso local"],
  "Local evidence": ["本地证据", "Evidencia local"],
  "Sign in & connect": ["登录并连接", "Iniciar sesión y conectar"],
  "This summary is the review": ["这份摘要就是审阅", "Este resumen es la revisión"],
  "Check summary again": ["再次检查摘要", "Volver a comprobar el resumen"],
  "Send unlocks only after these exact figures are verified on this Mac. What you see summarized here is exactly what would be sent.": ["只有在这台 Mac 上校验完这些确切数字后，“发送”才会解锁。你在此看到的摘要内容正是将要发送的内容。", "Enviar se desbloquea solo después de que estas cifras exactas se verifiquen en este Mac. Lo que ves resumido aquí es exactamente lo que se enviaría."],
  "Approve once": ["一次核准", "Aprobar una vez"],
  "Automatic full-history contribution": ["自动贡献完整历史", "Contribución automática del historial completo"],
  "Not approved": ["未核准", "No aprobado"],
  "This build's companion supports incremental upload. Approval covers the kind of data, once — after it, your full history uploads and stays current without per-batch review.": ["此构建的伴随程序支持增量上传。核准针对数据类型，只需一次——此后你的完整历史会上传并保持最新，无需逐批审阅。", "El acompañante de esta compilación admite carga incremental. La aprobación cubre el tipo de datos, una sola vez; después, tu historial completo se carga y se mantiene al día sin revisión por lotes."],
  "Your full usage history uploads first; new events then upload roughly every 6 hours.": ["首先上传你的完整使用历史；此后新事件大约每 6 小时上传一次。", "Primero se carga tu historial de uso completo; luego los eventos nuevos se cargan aproximadamente cada 6 horas."],
  "Community estimates recompute when your data or corrections to it arrive, including for past months.": ["当你的数据或对它的更正到达时，社区估计会重新计算，包括过去的月份。", "Las estimaciones comunitarias se recalculan cuando llegan tus datos o correcciones, incluso para meses pasados."],
  "Deletion removes everything you contributed, always.": ["删除会移除你贡献的所有内容，任何时候都是如此。", "La eliminación quita todo lo que aportaste, siempre."],
  "The exact kind of data covered": ["涵盖的数据类型明细", "El tipo exacto de datos cubiertos"],
  "Covered: token counts, model identifiers or keyed fingerprints, tier, surface and outcome categories, timestamps, quota percentages, tool-class counts per session, and stable pseudonymous session identifiers.": ["涵盖：令牌数量、模型标识符或密钥指纹、层级、界面与结果类别、时间戳、额度百分比、每个会话的工具类别计数，以及稳定的化名会话标识符。", "Cubierto: recuentos de tokens, identificadores de modelo o huellas con clave, categorías de nivel, superficie y resultado, marcas de tiempo, porcentajes de cuota, recuentos de clases de herramientas por sesión e identificadores de sesión seudónimos estables."],
  "Never covered: prompts, responses, file names, paths, commands, or any account identifier.": ["绝不涵盖：提示词、回复、文件名、路径、命令或任何帐户标识符。", "Nunca cubierto: indicaciones, respuestas, nombres de archivo, rutas, comandos ni ningún identificador de cuenta."],
  "Approve this kind of data": ["核准这类数据", "Aprobar este tipo de datos"],
  "Approval is asked once. Only a change to the kind of data or the destination asks again.": ["核准只询问一次。只有数据类型或目的地发生变化时才会再次询问。", "La aprobación se pide una sola vez. Solo un cambio en el tipo de datos o el destino vuelve a preguntar."],
  "Minimum observed quota span": ["最低观测额度跨度", "Intervalo mínimo de cuota observado"],
  "50+ pp": ["50+ 个百分点", "50+ pp"],
  "Local time": ["本地时间", "Hora local"],
  "Skip to monitoring dashboard": ["跳到监测仪表板", "Ir al panel de seguimiento"],
  "Connecting": ["正在连接", "Conectando"],
  "Analyze local usage": ["分析本地使用情况", "Analizar el uso local"],
  "Overview": ["概览", "Resumen"],
  "Allowance": ["额度", "Límite"],
  "Trends": ["趋势", "Tendencias"],
  "How it works": ["工作原理", "Cómo funciona"],
  "Community": ["社区", "Comunidad"],
  "Local evidence dashboard": ["本地证据仪表板", "Panel de evidencia local"],
  "Your Codex allowance, made measurable.": ["让你的 Codex 额度变得可衡量。", "Haz medible tu límite de Codex."],
  "Latest observation": ["最新观测", "Última observación"],
  "Checking…": ["正在检查…", "Comprobando…"],
  "Local companion": ["本地伴随程序", "Compañero local"],
  "Local companion unavailable": ["本地伴随程序不可用", "El compañero local no está disponible"],
  "Explore labeled demo": ["查看标注演示", "Explorar demostración etiquetada"],
  "First-time setup": ["首次设置", "Configuración inicial"],
  "Open TiboTattle on this Mac": ["在这台 Mac 上打开 TiboTattle", "Abre TiboTattle en este Mac"],
  "Get the Mac app": ["获取 Mac 应用", "Obtén la app para Mac"],
  "Download TiboTattle for Mac": ["下载适用于 Mac 的 TiboTattle", "Descargar TiboTattle para Mac"],
  "Release notes": ["发行说明", "Notas de la versión"],
  "Privacy": ["隐私", "Privacidad"],
  "Security": ["安全", "Seguridad"],
  "Support": ["支持", "Soporte"],
  "Open it from Applications": ["从“应用程序”打开它", "Ábrela desde Aplicaciones"],
  "Open installed app": ["打开已安装的应用", "Abrir la app instalada"],
  "Use the TiboTattle in-app window": ["使用 TiboTattle 应用内窗口", "Usa la ventana integrada de TiboTattle"],
  "Local setup": ["本地设置", "Configuración local"],
  "Check this Mac before analyzing": ["分析前检查这台 Mac", "Comprueba este Mac antes de analizar"],
  "Share": ["分享", "Compartir"],
  "Save image": ["保存图片", "Guardar imagen"],
  "Copy image": ["复制图片", "Copiar imagen"],
  "History": ["历史记录", "Historial"],
  "Each reset estimate is shown with the range supported by that reset’s observations.": ["每个重置估计都显示该重置观测所支持的范围。", "Cada estimación de restablecimiento muestra el intervalo respaldado por las observaciones de ese restablecimiento."],
  "See individual usage changes": ["查看单个使用变化", "Ver cambios individuales de uso"],
  "Local usage over time": ["本地使用情况随时间变化", "Uso local a lo largo del tiempo"],
  "Observed allowance remaining": ["观测到的剩余额度", "Cuota restante observada"],
  "Window boundary or track change": ["窗口边界或额度轨道变化", "Límite de ventana o cambio de seguimiento"],
  "Movement needs context": ["变化需要上下文", "El movimiento necesita contexto"],
  "Indexed history": ["已索引历史", "Historial indexado"],
  "Model usage": ["模型使用情况", "Uso por modelo"],
  "A model on a separate allowance is listed on its own row and carries no API equivalent, because that figure cannot be compared with the main allowance. Nothing unavailable is replaced with an invented cost.": ["使用独立额度的模型会单独列为一行，并且不显示 API 等价值，因为该数值无法与主额度比较。任何不可用的数据都不会被虚构成本替代。", "Un modelo con una cuota independiente aparece en su propia fila y no lleva equivalente de API, porque esa cifra no se puede comparar con la cuota principal. Nada que no esté disponible se sustituye por un coste inventado."],
  "Replay-safe usage grouped by model, across every allowance": ["按模型分组的可安全重放使用情况，涵盖所有额度", "Uso seguro para reproducción agrupado por modelo, en todas las cuotas"],
  "Review before sending": ["发送前审阅", "Revisar antes de enviar"],
  "Prepare and review a contribution": ["准备并审阅贡献", "Preparar y revisar una contribución"],
  "Nothing sends automatically": ["不会自动发送任何内容", "Nada se envía automáticamente"],
  "Dashboard contract: waiting": ["仪表板契约：等待中", "Contrato del panel: en espera"],
  "Checking service": ["正在检查服务", "Comprobando el servicio"],
  "Observed": ["已观测", "Observado"],
  "Reported time": ["报告时间", "Hora informada"],
  "Chart and table use this Mac’s reporting time zone.": ["图表和表格使用这台 Mac 的报告时区。", "El gráfico y la tabla usan la zona horaria de informes de este Mac."],
  "Estimate": ["估计", "Estimación"],
  "Status": ["状态", "Estado"],
  "Hour": ["小时", "Hora"],
  "Day": ["天", "Día"],
  "Week": ["周", "Semana"],
  "Reset view": ["重置视图", "Restablecer vista"],
  "Later →": ["之后 →", "Después →"],
  "← Earlier": ["← 之前", "← Antes"],
  "Residuals": ["残差", "Residuos"],
  "Expected": ["预期", "Esperado"],
  "Difference": ["差异", "Diferencia"],
  "Optional": ["可选", "Opcional"],
  "Good to know": ["值得了解", "Información útil"],
  "Help improve community estimates by sharing one summary. You see it before anything is sent.": ["分享一份摘要，帮助改进社区估算。发送前你可以先查看它。", "Ayuda a mejorar las estimaciones de la comunidad compartiendo un resumen. Lo verás antes de que se envíe nada."],
  "Shared: times, token counts, model names, broad activity categories, and how much of your allowance was left.": ["会分享：时间、令牌数量、模型名称、大致的活动类别，以及你的额度还剩多少。", "Se comparte: horas, recuentos de tokens, nombres de modelos, categorías generales de actividad y cuánto quedaba de tu cuota."],
  "Never shared: anything you typed or a model wrote, file names, folders, links, commands, your name, your email, or any account or login details.": ["绝不分享：你输入的或模型生成的任何内容、文件名、文件夹、链接、命令、你的姓名、电子邮件，或任何账户或登录信息。", "Nunca se comparte: nada de lo que escribiste ni de lo que escribió un modelo, nombres de archivos, carpetas, enlaces, comandos, tu nombre, tu correo ni ningún dato de cuenta o inicio de sesión."],
  "Sign in to contribute": ["登录以参与贡献", "Inicia sesión para contribuir"],
  "Contributing uses your Google or Apple sign-in. We keep a scrambled version of it that cannot be turned back into your email or your name. Using TiboTattle on your own needs no account.": ["贡献时会使用你的 Google 或 Apple 登录。我们只保留经过打乱处理的版本，无法还原成你的电子邮件或姓名。单独使用 TiboTattle 不需要账户。", "Contribuir usa tu inicio de sesión de Google o Apple. Guardamos una versión codificada que no se puede convertir de vuelta en tu correo ni en tu nombre. Usar TiboTattle por tu cuenta no necesita ninguna cuenta."],
  "Signing out ends this app's contribution session.": ["退出登录会结束此应用的贡献会话。", "Cerrar sesión finaliza la sesión de contribución de esta app."],
  "This app already has a contribution session. Signing out ends it.": ["此应用已有贡献会话。退出登录会结束该会话。", "Esta app ya tiene una sesión de contribución. Cerrar sesión la finaliza."],
  "I want to review a summary and decide whether to send it.": ["我想先查看摘要，再决定是否发送。", "Quiero revisar un resumen y decidir si lo envío."],
  "Connected. Look at the summary below before deciding whether to send it. Nothing will repeat automatically.": ["已连接。请先查看下方的摘要，再决定是否发送。不会自动重复。", "Conectado. Mira el resumen de abajo antes de decidir si lo envías. Nada se repetirá automáticamente."],
  "Sending now. This runs once and then stops.": ["正在发送。此操作只运行一次，然后停止。", "Enviando. Esto se ejecuta una vez y luego se detiene."],
  "Checking the summary on this Mac. Nothing is sent while you look at it.": ["正在这台 Mac 上检查摘要。你查看期间不会发送任何内容。", "Comprobando el resumen en este Mac. No se envía nada mientras lo miras."],
  "Look at the times and totals above, then confirm the send.": ["请查看上方的时间和总量，然后确认发送。", "Mira las horas y los totales de arriba y confirma el envío."],
  "Connect this Mac": ["连接这台 Mac", "Conectar este Mac"],
  "Sign in above to contribute": ["请在上方登录以参与贡献", "Inicia sesión arriba para contribuir"],
  "See what the community published": ["查看社区已发布的内容", "Ver lo que ha publicado la comunidad"],
  "Everything here happens on your Mac. Sending is a separate button you press after you have looked at the summary.": ["这里的所有操作都在你的 Mac 上完成。发送是另一个按钮，你查看摘要后再按。", "Todo lo de aquí ocurre en tu Mac. Enviar es un botón aparte que pulsas después de mirar el resumen."],
  "Prepare a summary": ["准备摘要", "Preparar un resumen"],
  "How much to include": ["包含多少内容", "Cuánto incluir"],
  "Analyze your local usage first to see how much would be included.": ["先分析本地使用情况，看看会包含多少内容。", "Analiza primero tu uso local para ver cuánto se incluiría."],
  "Nothing to share in this period. Choose a longer period, or analyze your local usage again.": ["此期间没有可分享的内容。请选择更长的时间段，或重新分析本地使用情况。", "No hay nada que compartir en este período. Elige un período más largo o vuelve a analizar tu uso local."],
  "Nothing is sent until you have looked at the summary and pressed Send.": ["在你查看摘要并按下发送之前，不会发送任何内容。", "No se envía nada hasta que hayas mirado el resumen y pulses Enviar."],
  "Your summary": ["你的摘要", "Tu resumen"],
  "Not reviewed yet": ["尚未查看", "Aún sin revisar"],
  "Time covered": ["覆盖的时间", "Período cubierto"],
  "Items included": ["包含的条目", "Elementos incluidos"],
  "Upload size": ["上传大小", "Tamaño de la carga"],
  "Review summary": ["查看摘要", "Revisar resumen"],
  "Send summary": ["发送摘要", "Enviar resumen"],
  "Send stays off until you have looked at this summary.": ["在你查看此摘要之前，发送将保持关闭。", "Enviar permanece desactivado hasta que hayas mirado este resumen."],
  "Checking that this build has a contribution service…": ["正在检查此版本是否配置了贡献服务…", "Comprobando que esta versión tenga un servicio de contribución…"],
  "Creating pseudonymous contribution access…": ["正在创建匿名贡献访问权限…", "Creando acceso de contribución seudónimo…"],
  "Connecting this Mac as an upload-only device…": ["正在将这台 Mac 连接为仅上传设备…", "Conectando este Mac como dispositivo solo de carga…"],
  "Reading the local contribution queue…": ["正在读取本地贡献队列…", "Leyendo la cola de contribuciones local…"],
  "Preparing a local summary for you to review…": ["正在准备供你查看的本地摘要…", "Preparando un resumen local para que lo revises…"],
  "Opening the local review…": ["正在打开本地审阅…", "Abriendo la revisión local…"],
  "This is a development build. It signs summaries with a file on this Mac instead of your login Keychain.": ["这是开发版本。它使用这台 Mac 上的文件而不是你的登录钥匙串来签署摘要。", "Esta es una versión de desarrollo. Firma los resúmenes con un archivo de este Mac en lugar de tu llavero de inicio de sesión."],
  "TiboTattle cannot reach your Mac's login Keychain, so preparing a summary will fail. Open Keychain Access, unlock the login Keychain, then try again. Do not delete or reset the entry.": ["TiboTattle 无法访问这台 Mac 的登录钥匙串，因此准备摘要会失败。请打开“钥匙串访问”，解锁登录钥匙串后重试。不要删除或重置该条目。", "TiboTattle no puede acceder al llavero de inicio de sesión de tu Mac, así que preparar un resumen fallará. Abre Acceso a Llaveros, desbloquea el llavero de inicio de sesión y vuelve a intentarlo. No elimines ni restablezcas la entrada."],
  "Ready to review": ["可以查看", "Listo para revisar"],
  "Nothing waiting": ["没有等待中的内容", "Nada en espera"],
  "Not set up": ["尚未设置", "Sin configurar"],
  "This build cannot store a prepared summary.": ["此版本无法存储已准备的摘要。", "Esta versión no puede almacenar un resumen preparado."],
  "Review contribution": ["审阅贡献", "Revisar contribución"],
  "Clearing the unusable local device credential…": ["正在清除不可用的本地设备凭据…", "Borrando la credencial local del dispositivo que no se puede usar…"],
  "Not now": ["暂不", "Ahora no"],
  "24 hours": ["24 小时", "24 horas"],
  "7 days": ["7 天", "7 días"],
  "Delayed community evidence": ["延迟社区活动", "Actividad comunitaria diferida"],
  "Published weekly snapshot": ["已发布的每周快照", "Resumen semanal publicado"],
  "Snapshot": ["快照", "Resumen"],
  "Mac app": ["Mac 应用", "App para Mac"],
  "FAQ": ["常见问题", "Preguntas frecuentes"],
  "Mac app availability": ["Mac 应用可用性", "Disponibilidad de la app para Mac"],
  "See the snapshot": ["查看快照", "Ver el resumen"],
  "Signed Mac installer": ["已签名的 Mac 安装程序", "Instalador de Mac firmado"],
  "Download for Mac": ["下载 Mac 版", "Descargar para Mac"],
  "Choose what to share": ["选择要分享的内容", "Elige qué compartir"],
  "Local-first by design": ["本地优先设计", "Local primero por diseño"],
  "TiboTattle · Private usage visibility for Mac": ["TiboTattle · 面向 Mac 的私密使用情况可见性", "TiboTattle · Visibilidad privada de uso para Mac"],
  "Skip to TiboTattle": ["跳到 TiboTattle", "Ir a TiboTattle"],
  "Docs": ["文档", "Documentación"],
  "Release status": ["发布状态", "Estado de la versión"],
  "See where your Codex allowance stands.": ["查看你的 Codex 额度状况。", "Consulta el estado de tu límite de Codex."],
  "TiboTattle is a private Mac app that estimates how much of your seven-day Codex allowance remains and shows how your usage changes over time. Your personal dashboard is calculated on your Mac.": ["TiboTattle 是一款私密的 Mac 应用，可估算你的 Codex 七天额度还剩多少，并展示使用情况随时间的变化。你的个人仪表板会在 Mac 上计算。", "TiboTattle es una app privada para Mac que estima cuánto queda de tu límite de Codex de siete días y muestra cómo cambia tu uso con el tiempo. Tu panel personal se calcula en tu Mac."],
  "Public download coming soon.": ["公开下载即将推出。", "La descarga pública estará disponible pronto."],
  "We will make the signed Mac installer available here when it is ready.": ["已签名的 Mac 安装程序准备就绪后，我们会在此提供下载。", "Ofreceremos aquí el instalador firmado para Mac cuando esté listo."],
  "Latest community evidence": ["最新社区证据", "Evidencia comunitaria más reciente"],
  "Install the Mac app": ["安装 Mac 应用", "Instala la app para Mac"],
  "Open TiboTattle and let it calculate your Codex usage locally.": ["打开 TiboTattle，让它在本地计算你的 Codex 使用情况。", "Abre TiboTattle y deja que calcule tu uso de Codex de forma local."],
  "See your week": ["查看你的一周", "Consulta tu semana"],
  "View your allowance estimate and history in the app.": ["在应用中查看额度估计和历史记录。", "Consulta en la app la estimación de tu límite y su historial."],
  "Share only if you choose": ["仅在你选择时分享", "Comparte solo si quieres"],
  "Review a content-free summary before any optional community contribution.": ["在选择向社区贡献之前，先查看不含内容的摘要。", "Revisa un resumen sin contenido antes de cualquier contribución opcional a la comunidad."],
  "When available, this is a delayed, anonymous activity summary from people who chose to contribute.": ["如有可用数据，这里会显示选择贡献者的延迟匿名活动摘要。", "Cuando esté disponible, aquí se mostrará un resumen anónimo y diferido de la actividad de quienes decidieron contribuir."],
  "Personal dashboards and contributions stay in the Mac app.": ["个人仪表板和贡献功能保留在 Mac 应用中。", "Los paneles personales y las contribuciones permanecen en la app para Mac."],
  "See community activity details": ["查看社区活动详情", "Ver detalles de la actividad comunitaria"],
  "Published activity": ["已发布活动", "Actividad publicada"],
  "Delayed, rounded totals for the published reporting period.": ["已发布报告期间的延迟取整总量。", "Totales diferidos y redondeados del período de informe publicado."],
  "Understand your Codex week.": ["了解你的 Codex 一周。", "Entiende tu semana de Codex."],
  "TiboTattle is a local-first Mac app for understanding personal Codex usage. It estimates your personal seven-day allowance in API-equivalent terms; the dashboard and its history stay on your Mac.": ["TiboTattle 是一款本地优先的 Mac 应用，用于了解个人 Codex 使用情况。它以 API 等价值估算你的个人七天额度；仪表板及其历史记录保留在你的 Mac 上。", "TiboTattle es una app para Mac que prioriza lo local y ayuda a entender tu uso personal de Codex. Estima tu límite personal de siete días en términos equivalentes de API; el panel y su historial permanecen en tu Mac."],
  "Download for macOS": ["下载 macOS 版", "Descargar para macOS"],
  "Already installed?": ["已经安装？", "¿Ya está instalada?"],
  "Open TiboTattle": ["打开 TiboTattle", "Abrir TiboTattle"],
  "Signed release coming soon.": ["已签名版本即将推出。", "Próximamente habrá una versión firmada."],
  "A download link appears only after a signed public installer and its release metadata pass the release checks. Otherwise, this release remains unavailable.": ["只有在已签名的公开安装程序及其发行元数据通过发行检查后，才会显示下载链接。否则，此版本仍不可用。", "El enlace de descarga solo aparece después de que un instalador público firmado y sus metadatos de versión superen las comprobaciones. De lo contrario, esta versión no está disponible."],
  "This website is read-only: it does not enroll contributors or accept uploads.": ["本网站是只读的：不会为贡献者注册账户或接受上传。", "Este sitio web es de solo lectura: no registra colaboradores ni acepta cargas."],
  "Delayed community activity": ["延迟的社区活动", "Actividad comunitaria diferida"],
  "Checking snapshot": ["正在检查快照", "Comprobando el resumen"],
  "Demo data": ["演示数据", "Datos de demostración"],
  "Seven-day allowance estimate": ["七天额度估计", "Estimación de asignación de siete días"],
  "$1,879": ["$1,879", "$1,879"],
  "per 7 days": ["每 7 天", "por 7 días"],
  "Example only — not your usage or a bill.": ["仅作示例 — 不是你的使用情况或账单。", "Solo es un ejemplo; no es tu uso ni una factura."],
  "Observed resets": ["已观测到的重置", "Restablecimientos observados"],
  "Allowance remaining": ["剩余额度", "Asignación restante"],
  "61%": ["61%", "61%"],
  "Your dashboard is calculated privately on your Mac.": ["你的仪表板会在 Mac 上私密计算。", "Tu panel se calcula de forma privada en tu Mac."],
  "Personal seven-day view": ["个人七天视图", "Vista personal de siete días"],
  "On your Mac, see your private allowance estimate and its history across observed resets.": ["在你的 Mac 上查看私人的额度估计及其在已观测重置间的历史记录。", "En tu Mac, consulta tu estimación privada del límite y su historial entre restablecimientos observados."],
  "Local by default": ["默认保留在本地", "Local de forma predeterminada"],
  "Your dashboard stays on your Mac. Community contribution is optional.": ["你的仪表板保留在 Mac 上。是否贡献给社区由你决定。", "Tu panel permanece en tu Mac. La contribución a la comunidad es opcional."],
  "Evidence, not guesses": ["基于证据，而非猜测", "Evidencia, no conjeturas"],
  "Missing or weak evidence stays visibly unknown.": ["缺失或薄弱的证据会明确显示为未知。", "La evidencia ausente o débil permanece visiblemente desconocida."],
  "Published as delayed, aggregate activity for a defined reporting period.": ["以定义报告期间的延迟汇总活动形式发布。", "Se publica como actividad agregada y diferida para un período de informe definido."],
  "Checking for the latest delayed aggregate snapshot…": ["正在检查最新的延迟汇总快照…", "Comprobando el último resumen agregado y diferido…"],
  "Checking for the latest delayed weekly snapshot…": ["正在检查最新的延迟每周快照…", "Comprobando el último resumen semanal diferido…"],
  "How community activity snapshots work": ["社区活动快照的工作方式", "Cómo funcionan los resúmenes de actividad comunitaria"],
  "Community activity": ["社区活动", "Actividad comunitaria"],
  "Shown as aggregate activity for the published period.": ["以已发布期间的汇总活动形式显示。", "Se muestra como actividad agregada del período publicado."],
  "Snapshot and source details": ["快照和来源详情", "Detalles del resumen y la fuente"],
  "Values are delayed, rounded activity totals supplied by contributors. This page does not turn them into a personal reading or a statement about everyone.": ["数值是贡献者提供的延迟、取整活动总量。本页不会将其转换为个人读数或关于所有人的结论。", "Los valores son totales de actividad diferida y redondeada proporcionados por colaboradores. Esta página no los convierte en una lectura personal ni en una afirmación sobre todo el mundo."],
  "Local-first and independent. Not affiliated with OpenAI.": ["本地优先且独立。与 OpenAI 无关。", "Local e independiente. Sin afiliación con OpenAI."],
  "GitHub": ["GitHub", "GitHub"],
  "X": ["X", "X"],
  "Turn on JavaScript to check download availability and the public community snapshot.": ["启用 JavaScript 以查看下载可用性和公开社区快照。", "Activa JavaScript para consultar la disponibilidad de descarga y el resumen comunitario público."],
  "Skip to the community snapshot": ["跳到社区快照", "Ir al resumen comunitario"],
  "Private usage visibility for Mac": ["面向 Mac 的私密使用情况可见性", "Visibilidad privada de uso para Mac"],
  "Know what your Codex week is doing.": ["了解你的 Codex 一周使用情况。", "Conoce qué está ocurriendo en tu semana de Codex."],
  "TiboTattle is a local-first Mac app that reads content-free usage and quota metadata on your Mac. Your personal dashboard stays in the app; this site only publishes delayed, aggregate activity that contributors chose to share.": ["TiboTattle 是一款本地优先的 Mac 应用，会在你的 Mac 上读取不含内容的使用情况和额度元数据。你的个人仪表板保留在应用内；本网站只发布贡献者选择分享的延迟汇总活动。", "TiboTattle es una app para Mac que prioriza lo local y lee metadatos de uso y cuota sin contenido en tu Mac. Tu panel personal permanece en la app; este sitio solo publica actividad agregada y diferida que los colaboradores eligieron compartir."],
  "A delayed activity snapshot, shared carefully.": ["谨慎分享的延迟活动快照。", "Un resumen de actividad diferida, compartido con cuidado."],
  "This page shows delayed, aggregate weekly activity from opt-in contributors — not your personal usage, reading, or cost.": ["本页展示自愿贡献者的延迟汇总每周活动，而不是你的个人使用情况、读数或成本。", "Esta página muestra actividad semanal agregada y diferida de colaboradores que aceptaron participar, no tu uso, lectura ni coste personal."],
  "A public community activity snapshot appears only when the service publishes one; this page does not derive one from activity totals.": ["只有服务发布公开社区活动快照时才会显示；本页不会根据活动总量推导快照。", "Un resumen público de actividad comunitaria solo aparece cuando el servicio publica uno; esta página no lo deriva de los totales de actividad."],
  "Community activity snapshot": ["社区活动快照", "Resumen de actividad comunitaria"],
  "How this snapshot is produced": ["此快照如何生成", "Cómo se produce este resumen"],
  "Community values use a fixed delay, eligible provider-account support, account-level clipping, and coarse rounding. A sealed revision is never rewritten; privacy-affecting deletion withdraws it and schedules a replacement revision without the deleted source.": ["社区数值采用固定延迟、符合条件的提供商账户支持、账户级别截断和粗粒度取整。已封存的修订绝不会被重写；影响隐私的删除会撤回该修订，并安排不含已删除来源的替代修订。", "Los valores comunitarios usan un retraso fijo, soporte de cuentas de proveedor elegibles, recorte por cuenta y redondeo grueso. Una revisión sellada nunca se reescribe; una eliminación que afecta a la privacidad la retira y programa una revisión de sustitución sin la fuente eliminada."],
  "Keep your personal view on your Mac.": ["让你的个人视图留在 Mac 上。", "Mantén tu vista personal en tu Mac."],
  "The app reads your local Codex metadata and shows the personal dashboard in its own window. The website never asks for access to those files, and nothing is uploaded unless you explicitly choose to contribute from the app.": ["该应用会读取你的本地 Codex 元数据，并在自己的窗口中显示个人仪表板。网站绝不会请求访问这些文件，除非你明确选择在应用中贡献，否则不会上传任何内容。", "La app lee tus metadatos locales de Codex y muestra el panel personal en su propia ventana. El sitio web nunca solicita acceso a esos archivos y no se sube nada salvo que elijas explícitamente contribuir desde la app."],
  "The signed Mac app is not available to download yet. We will only offer it here after its installer and release metadata verify.": ["已签名的 Mac 应用尚不可下载。只有在其安装程序和发行元数据通过验证后，我们才会在此提供它。", "La app firmada para Mac todavía no está disponible para descargar. Solo la ofreceremos aquí cuando se verifiquen su instalador y sus metadatos de lanzamiento."],
  "Open TiboTattle from Applications": ["从“应用程序”打开 TiboTattle", "Abre TiboTattle desde Aplicaciones"],
  "The personal dashboard opens inside the Mac app and uses its private loopback companion.": ["个人仪表板在 Mac 应用内打开，并使用其私有回环伴随程序。", "El panel personal se abre dentro de la app para Mac y usa su acompañante de bucle local privado."],
  "Any community contribution is optional, delayed, clipped, and rounded before a public snapshot can be released.": ["任何社区贡献都是可选的，并会在发布公开快照前经过延迟、截断和取整。", "Toda contribución comunitaria es opcional, se retrasa, se recorta y se redondea antes de poder publicar un resumen."],
  "A clear boundary for personal data.": ["个人数据的清晰边界。", "Un límite claro para los datos personales."],
  "On your Mac": ["在你的 Mac 上", "En tu Mac"],
  "Personal evidence stays local.": ["个人证据保留在本地。", "La evidencia personal permanece local."],
  "TiboTattle reads content-free metadata locally for the personal dashboard. Raw prompts, responses, transcripts, and file paths are not part of this public page.": ["TiboTattle 会在本地读取不含内容的元数据以提供个人仪表板。原始提示词、回复、转录内容和文件路径不属于此公开页面。", "TiboTattle lee metadatos sin contenido localmente para el panel personal. Las indicaciones, respuestas, transcripciones y rutas de archivos sin procesar no forman parte de esta página pública."],
  "In the snapshot": ["在快照中", "En el resumen"],
  "Only delayed aggregate totals appear.": ["只显示延迟的汇总总量。", "Solo aparecen totales agregados y diferidos."],
  "The public view is delayed and support-gated. Released metrics are clipped per participant, rounded down, and may show a status instead of a value when support is insufficient.": ["公开视图经过延迟处理并受支持门槛限制。已发布指标按参与者截断并向下取整；当支持不足时，可能显示状态而非数值。", "La vista pública se retrasa y está sujeta a un umbral de soporte. Las métricas publicadas se recortan por participante, se redondean hacia abajo y pueden mostrar un estado en lugar de un valor cuando el soporte es insuficiente."],
  "A few useful boundaries": ["几个重要边界", "Algunos límites útiles"],
  "Can this website show my personal usage?": ["这个网站能显示我的个人使用情况吗？", "¿Puede este sitio web mostrar mi uso personal?"],
  "No. Your personal dashboard is a Mac-app surface backed by the local loopback companion. This page only requests the public community snapshot endpoint.": ["不能。你的个人仪表板是由本地回环伴随程序支持的 Mac 应用界面。本页只请求公开的社区快照端点。", "No. Tu panel personal es una superficie de la app para Mac respaldada por el acompañante de bucle local. Esta página solo solicita el punto de conexión público del resumen comunitario."],
  "What do the published numbers mean?": ["已发布的数字代表什么？", "¿Qué significan los números publicados?"],
  "They are delayed activity totals from contributors, clipped per participant and rounded down. A cell can instead show a release status. They do not describe an individual or group limit.": ["它们是来自贡献者的延迟活动总数，按参与者截断并向下取整。单元格也可能显示发布状态。它们不描述个人或群体限额。", "Son totales de actividad diferida de colaboradores, recortados por participante y redondeados hacia abajo. Una celda puede mostrar en su lugar un estado de publicación. No describen un límite individual o de grupo."],
  "Why might Download for Mac be unavailable?": ["为什么 Mac 版下载可能不可用？", "¿Por qué podría no estar disponible Descargar para Mac?"],
  "The download remains hidden until a signed public installer and its release metadata pass the fixed checks. No placeholder or unverified artifact is offered.": ["在已签名的公开安装程序及其发行元数据通过固定检查前，下载会保持隐藏。不会提供占位符或未经验证的工件。", "La descarga permanece oculta hasta que un instalador público firmado y sus metadatos de lanzamiento superen las comprobaciones establecidas. No se ofrece ningún marcador de posición ni artefacto no verificado."],
  "TiboTattle · evidence, uncertainty, and privacy boundaries kept visible.": ["TiboTattle · 让证据、不确定性和隐私边界保持可见。", "TiboTattle · evidencia, incertidumbre y límites de privacidad visibles."],
  "Named with affection for the Codex community. Not affiliated with or endorsed by OpenAI or Thibault Sottiaux — and we will happily rename if asked.": ["这个名字是对 Codex 社区的亲切致意。它与 OpenAI 或 Thibault Sottiaux 没有隶属或认可关系；如被要求，我们会乐意更名。", "Nombrado con afecto por la comunidad de Codex. No está afiliado a OpenAI ni a Thibault Sottiaux, ni cuenta con su respaldo; cambiaremos el nombre con gusto si nos lo piden."],
  "JavaScript is required to show the published community snapshot and available download details. The page does not contain a local dashboard or a personal-data control.": ["需要 JavaScript 才能显示已发布的社区快照和可用下载详情。该页面不包含本地仪表板或个人数据控件。", "Se requiere JavaScript para mostrar el resumen comunitario publicado y los detalles de descarga disponibles. La página no contiene un panel local ni un control de datos personales."],
  "Cancel": ["取消", "Cancelar"],
  "Compare content-free token metadata with observed quota movement, see what the model can and cannot explain, and improve the estimate over time.": ["将不含内容的令牌元数据与观测到的额度变化进行比较，了解模型能解释和不能解释的内容，并随时间改进估计。", "Compara metadatos de tokens sin contenido con el movimiento de cuota observado, ve qué puede y no puede explicar el modelo y mejora la estimación con el tiempo."],
  "Open TiboTattle from Applications and use the in-app window it opens. Nothing has been presented as your real usage.": ["从“应用程序”打开 TiboTattle，并使用它打开的应用内窗口。尚未将任何内容呈现为你的真实使用情况。", "Abre TiboTattle desde Aplicaciones y usa la ventana integrada que abre. No se ha presentado nada como tu uso real."],
  "Check again": ["再次检查", "Comprobar de nuevo"],
  "A normal website cannot read Codex files. The TiboTattle Mac app runs a private loopback companion, reads metadata locally, and opens your dashboard in its own TiboTattle in-app window.": ["普通网站无法读取 Codex 文件。TiboTattle Mac 应用会运行私有回环伴随程序，在本地读取元数据，并在自己的 TiboTattle 应用内窗口中打开你的仪表板。", "Un sitio web normal no puede leer archivos de Codex. La app TiboTattle para Mac ejecuta un acompañante de bucle local privado, lee metadatos localmente y abre tu panel en su propia ventana integrada de TiboTattle."],
  "A public installer is not configured for this build. If you already received the app, continue below.": ["此构建未配置公开安装程序。如果你已获得该应用，请继续执行以下步骤。", "No hay un instalador público configurado para esta compilación. Si ya recibiste la app, continúa abajo."],
  "Wait for": ["等待", "Espera a que aparezca"],
  "Ready": ["就绪", "Listo"],
  ", then open the dashboard in TiboTattle.": ["，然后在 TiboTattle 中打开仪表板。", " y luego abre el panel en TiboTattle."],
  "Your real usage appears only on that loopback page. This hosted page never receives permission to read local logs.": ["你的真实使用情况只会显示在该回环页面上。此托管页面永远不会获得读取本地日志的权限。", "Tu uso real solo aparece en esa página de bucle local. Esta página alojada nunca recibe permiso para leer registros locales."],
  "Check this page again": ["再次检查此页面", "Comprobar esta página de nuevo"],
  "This check only reconnects to the current page. If the app opened a TiboTattle window, continue there.": ["此检查只会重新连接当前页面。如果应用打开了 TiboTattle 窗口，请在其中继续。", "Esta comprobación solo vuelve a conectar la página actual. Si la app abrió una ventana de TiboTattle, continúa allí."],
  "You may close this hosted browser tab at any time. During an analysis, keep the TiboTattle app open; closing the app stops its local companion, while the last durable checkpoint remains available when you reopen it.": ["你可以随时关闭此托管浏览器标签页。分析期间请保持 TiboTattle 应用打开；关闭应用会停止其本地伴随程序，但重新打开后仍可使用最近的持久检查点。", "Puedes cerrar esta pestaña alojada del navegador en cualquier momento. Durante un análisis, mantén abierta la app TiboTattle; cerrarla detiene su acompañante local, mientras que el último punto de control persistente sigue disponible al volver a abrirla."],
  "TiboTattle checks only whether the expected Codex folders and its private state directory are available. It does not send or display prompts, responses, commands, paths, or account identifiers.": ["TiboTattle 只检查预期的 Codex 文件夹和其私有状态目录是否可用。它不会发送或显示提示词、回复、命令、路径或帐户标识符。", "TiboTattle solo comprueba si están disponibles las carpetas de Codex esperadas y su directorio de estado privado. No envía ni muestra indicaciones, respuestas, comandos, rutas ni identificadores de cuenta."],
  "A useful headline often appears in seconds. The first deep pass can take a few minutes; later updates are normally faster. Work stops or checkpoints at a fixed bound, so a large Codex history may continue in another pass. You may close the browser tab; keep the Usage Monitor app open while analysis runs.": ["有用的摘要通常会在几秒内出现。首次深度分析可能需要几分钟，之后的更新通常更快。工作会在固定边界处停止或保存检查点，因此大型 Codex 历史可能在下一次分析中继续。你可以关闭浏览器标签页；分析运行时请保持 Usage Monitor 应用打开。", "Un titular útil suele aparecer en segundos. La primera pasada profunda puede tardar unos minutos; las actualizaciones posteriores normalmente son más rápidas. El trabajo se detiene o guarda un punto de control en un límite fijo, por lo que un historial grande de Codex puede continuar en otra pasada. Puedes cerrar la pestaña del navegador; mantén abierta la app Usage Monitor mientras se ejecuta el análisis."],
  "01 · Overview": ["01 · 概览", "01 · Resumen"],
  "Where your allowance stands": ["你的额度状况", "Situación de tu límite"],
  "Current quota observations and API-price-equivalent usage from your local evidence.": ["来自本地证据的当前额度观测和 API 价格等值使用情况。", "Observaciones actuales de cuota y uso equivalente al precio de API a partir de tu evidencia local."],
  "Quota-weighted API-price equivalent": ["按额度加权的 API 价格等值", "Equivalente de precio de API ponderado por cuota"],
  "Replay-safe usage cost": ["可重放安全的使用成本", "Coste de uso seguro para reproducción"],
  "Standard-rate API prices applied to non-overlapping local token increments, then multiplied by the published Fast credit rate for increments whose effective mode is Fast. It tracks relative quota consumption; it is not a subscription charge or a published dollar limit.": ["将标准费率 API 价格应用于不重叠的本地令牌增量，再对有效模式为 Fast 的增量乘以公开的 Fast 抵扣费率。它跟踪相对额度消耗；不是订阅费用或公开的美元限额。", "Precios de API de tarifa estándar aplicados a incrementos locales de tokens no superpuestos y luego multiplicados por la tasa publicada de crédito Fast para incrementos cuyo modo efectivo es Fast. Registra el consumo relativo de cuota; no es un cargo de suscripción ni un límite en dólares publicado."],
  "Recorded period": ["记录期间", "Periodo registrado"],
  "Awaiting local evidence": ["等待本地证据", "En espera de evidencia local"],
  "This activity total can exceed the inferred weekly limit: it spans a calendar period, while the weekly estimate describes one observed reset track and may cross resets, credits, or account changes.": ["此活动总量可能超过推断的每周限额：它跨越一个日历期间，而每周估计描述的是一个观测到的重置轨迹，并且可能跨越重置、抵扣或帐户变化。", "Este total de actividad puede superar el límite semanal inferido: abarca un período de calendario, mientras que la estimación semanal describe una trayectoria de reinicio observada y puede cruzar reinicios, créditos o cambios de cuenta."],
  "Measured versus calculated": ["实测与计算", "Medido frente a calculado"],
  "Does token cost explain the quota change?": ["令牌成本能解释额度变化吗？", "¿El coste de tokens explica el cambio de cuota?"],
  "No evidence": ["无证据", "Sin evidencia"],
  "Observed quota movement": ["观测到的额度变化", "Movimiento de cuota observado"],
  "Cost-implied movement": ["成本推算的变化", "Movimiento implícito por el coste"],
  "More observations are required before a useful comparison can be made.": ["需要更多观测结果才能进行有意义的比较。", "Se requieren más observaciones antes de poder realizar una comparación útil."],
  "Central fitted rate": ["中心拟合比率", "Tasa central ajustada"],
  "Not estimable": ["无法估计", "No estimable"],
  "Plausible 80% range": ["可信的 80% 范围", "Rango plausible del 80 %"],
  "Example translation": ["示例换算", "Conversión de ejemplo"],
  "This fit uses API prices as a measuring stick. It is not a provider-published dollar allowance.": ["此拟合将 API 价格用作衡量标尺。它不是提供商发布的美元额度。", "Este ajuste usa precios de API como regla de medida. No es un límite en dólares publicado por el proveedor."],
  "A results card you can post": ["可发布的结果卡片", "Una tarjeta de resultados que puedes publicar"],
  "Reference pending": ["参考待定", "Referencia pendiente"],
  "A ready-to-post image of the three headline figures. It contains no prompts, responses, paths, account details, or raw activity.": ["包含三个摘要数字的可直接发布图像。其中不含提示词、回复、路径、帐户详情或原始活动。", "Una imagen lista para publicar de las tres cifras principales. No contiene indicaciones, respuestas, rutas, detalles de cuenta ni actividad sin procesar."],
  "A results card is generated once local evidence is available.": ["本地证据可用后会生成结果卡片。", "Se genera una tarjeta de resultados cuando hay evidencia local disponible."],
  "02 · Weekly allowance": ["02 · 每周额度", "02 · Límite semanal"],
  "Our best estimate of the seven-day limit": ["我们对七天限额的最佳估计", "Nuestra mejor estimación del límite de siete días"],
  "All-data median estimate": ["全部数据的中位数估计", "Estimación mediana de todos los datos"],
  "No evidence interval available": ["没有可用的证据区间", "No hay intervalo de evidencia disponible"],
  "The estimate will appear when local usage can be matched to quota changes.": ["当本地使用情况可与额度变化匹配时，将显示估计值。", "La estimación aparecerá cuando el uso local pueda coincidir con cambios de cuota."],
  "Allowance estimate history": ["额度估计历史", "Historial de estimaciones de límite"],
  "All": ["全部", "Todo"],
  "All-data median": ["全部数据的中位数", "Mediana de todos los datos"],
  "Observed across 50+ points": ["在 50 多个点中观测到", "Observado en más de 50 puntos"],
  "Short observation": ["短时观测", "Observación breve"],
  "No weekly estimates loaded.": ["未加载每周估计。", "No se cargaron estimaciones semanales."],
  "Individual seven-day reset estimates": ["单独的七天重置估计", "Estimaciones individuales de reinicio de siete días"],
  "Observed span": ["观测跨度", "Intervalo observado"],
  "Measured range": ["测量范围", "Rango medido"],
  "No weekly evidence loaded.": ["未加载每周证据。", "No se cargó evidencia semanal."],
  "03 · Timeline": ["03 · 时间线", "03 · Cronología"],
  "Usage and allowance over time": ["随时间变化的使用情况和额度", "Uso y límite a lo largo del tiempo"],
  "API-price-equivalent usage over time": ["随时间变化的 API 价格等值使用情况", "Uso equivalente al precio de API a lo largo del tiempo"],
  "API-price-equivalent usage": ["API 价格等价使用量", "Uso equivalente al precio de API"],
  "Seven-day allowance remaining": ["七天额度剩余", "Asignación de siete días restante"],
  "No real usage timeline loaded": ["未加载真实使用时间线", "No se cargó una cronología de uso real"],
  "Analyze local usage to build recent content-free usage buckets.": ["分析本地使用情况以构建最近的不含内容的使用分组。", "Analiza el uso local para generar grupos recientes de uso sin contenido."],
  "Advanced calibration: measured quota change versus calculated change": ["高级校准：实测额度变化与计算变化", "Calibración avanzada: cambio de cuota medido frente a cambio calculado"],
  "Observed quota change versus cost-implied change": ["观测到的额度变化与成本推算的变化", "Cambio de cuota observado frente a cambio implícito por el coste"],
  "Calibration window": ["校准窗口", "Ventana de calibración"],
  "15 min": ["15 分钟", "15 min"],
  "1 hour": ["1 小时", "1 hora"],
  "3 hours": ["3 小时", "3 horas"],
  "Observed quota": ["观测到的额度", "Cuota observada"],
  "Expected from API cost": ["根据 API 成本推算", "Esperado según el coste de API"],
  "Missing quota bracket": ["缺少额度区间", "Falta el tramo de cuota"],
  "No timeline loaded": ["未加载时间线", "No se cargó ninguna cronología"],
  "Connect the local companion or choose the labeled demo.": ["连接本地伴随程序或选择带标签的演示。", "Conecta el acompañante local o elige la demostración etiquetada."],
  "Observed versus calculated movement": ["观测变化与计算变化", "Movimiento observado frente al calculado"],
  "The difference between provider-reported quota movement and the movement implied by local usage changes. Quiet periods with no activity and no quota change are neutral, not errors.": ["提供方报告的额度变化与本地使用变化所推算变化之间的差值。没有活动且额度未变化的安静时段是中性状态，不是错误。", "La diferencia entre el movimiento de cuota informado por el proveedor y el implícito en los cambios de uso local. Los períodos sin actividad ni cambios de cuota son neutros, no errores."],
  "Residual = observed quota change minus cost-implied change. Positive values mean the allowance fell faster than the token model predicted. The axis covers the same date range as the calibration chart above; windows that cannot be differenced are shaded gaps, never zeros.": ["残差 = 观测到的额度变化减去成本推算的变化。正值表示额度下降得比令牌模型预测的更快。该轴覆盖与上方校准图相同的日期范围；无法求差的窗口会显示为阴影间隙，绝不是零。", "Residual = cambio de cuota observado menos cambio implícito por el coste. Los valores positivos significan que el límite cayó más rápido de lo que predijo el modelo de tokens. El eje cubre el mismo intervalo de fechas que el gráfico de calibración anterior; las ventanas que no se pueden diferenciar son huecos sombreados, nunca ceros."],
  "No residual evidence loaded.": ["未加载残差证据。", "No se cargó evidencia de residuales."],
  "Inspect exact periods": ["检查精确期间", "Inspeccionar períodos exactos"],
  "Exact windows and evidence state": ["精确窗口和证据状态", "Ventanas exactas y estado de evidencia"],
  "Largest unexplained quota movement periods": ["最大的未解释额度变化期间", "Períodos con mayor movimiento de cuota sin explicación"],
  "Evidence state": ["证据状态", "Estado de evidencia"],
  "No periods loaded.": ["未加载期间。", "No se cargaron períodos."],
  "7d": ["7 天", "7 días"],
  "31d": ["31 天", "31 días"],
  "24h": ["24 小时", "24 h"],
  "04 · Cost accounting": ["04 · 成本核算", "04 · Contabilidad de costes"],
  "How the estimate was calculated": ["估计的计算方式", "Cómo se calculó la estimación"],
  "30d": ["30 天", "30 días"],
  "API pricing is a measuring stick, not your bill.": ["API 定价是衡量标尺，不是你的账单。", "Los precios de API son una regla de medida, no tu factura."],
  "Each local usage change uses the public API price that was in effect when it occurred, with the published Fast multiplier when applicable. It is an equivalent for comparison, not an invoice.": ["每个本地使用变化都使用其发生时有效的公开 API 价格，并在适用时采用公开的 Fast 倍数。它是用于比较的等值，而不是账单。", "Cada cambio de uso local usa el precio público de API vigente cuando ocurrió, con el multiplicador Fast publicado cuando corresponde. Es un equivalente para comparar, no una factura."],
  "Token components": ["令牌组成", "Componentes de tokens"],
  "Token count": ["令牌数量", "Recuento de tokens"],
  "Every token belongs to one non-overlapping component. Output text excludes reasoning tokens; combined output is only used when a source does not provide that split.": ["每个令牌只属于一个不重叠的组成部分。输出文本不包括推理令牌；只有在来源未提供该拆分时才使用合并输出。", "Cada token pertenece a un componente no superpuesto. El texto de salida excluye los tokens de razonamiento; la salida combinada solo se usa cuando una fuente no proporciona esa división."],
  "Cost contribution": ["成本贡献", "Contribución al coste"],
  "API-equivalent cost": ["API 等值成本", "Coste equivalente de API"],
  "Standard-rate API equivalent by component. Coverage and price provenance stay visible without adding a guessed cost.": ["按组成部分计算的标准费率 API 等值。覆盖率和价格来源保持可见，不会加入猜测的成本。", "Equivalente de API de tarifa estándar por componente. La cobertura y la procedencia del precio permanecen visibles sin añadir un coste inventado."],
  "Models": ["模型", "Modelos"],
  "Model": ["模型", "Modelo"],
  "Usage changes": ["使用变化", "Cambios de uso"],
  "Tokens": ["令牌", "Tokens"],
  "API equivalent": ["API 等值", "Equivalente de API"],
  "Share one anonymous summary": ["分享一份匿名摘要", "Comparte un resumen anónimo"],
  "What leaves this Mac — and what never does": ["什么会离开这台 Mac，以及什么永远不会", "Qué sale de este Mac y qué no sale nunca"],
  "Not signed in": ["未登录", "Sin sesión iniciada"],
  "Sign in with Google": ["使用 Google 登录", "Iniciar sesión con Google"],
  "Sign in with Apple": ["使用 Apple 登录", "Iniciar sesión con Apple"],
  "Signed in with Google": ["已使用 Google 登录", "Sesión iniciada con Google"],
  "Sign out": ["退出登录", "Cerrar sesión"],
  "Check sign-in": ["检查登录状态", "Comprobar inicio de sesión"],
  "Cancel sign-in": ["取消登录", "Cancelar inicio de sesión"],
  "Hosted sign-in is not configured for this build.": ["此构建未配置托管登录。", "El inicio de sesión alojado no está configurado para esta compilación."],
  "Hosted Apple sign-in is not configured for this build.": ["此构建未配置托管 Apple 登录。", "El inicio de sesión alojado con Apple no está configurado para esta compilación."],
  "Checking": ["正在检查", "Comprobando"],
  "Prepare and review last 24 hours": ["准备并审阅最近 24 小时", "Preparar y revisar las últimas 24 horas"],
  "API-price estimate": ["API 价格估计", "Estimación de precio de API"],
  "Named with affection for the Codex community. Not affiliated with or endorsed by OpenAI or Thibault Sottiaux — and we will happily rename if asked. Your tokens tattle only to you.": ["这个名字是对 Codex 社区的亲切致意。它与 OpenAI 或 Thibault Sottiaux 没有隶属或认可关系；如被要求，我们会乐意更名。你的令牌只向你“告密”。", "Nombrado con afecto por la comunidad de Codex. No está afiliado a OpenAI ni a Thibault Sottiaux, ni cuenta con su respaldo; cambiaremos el nombre con gusto si nos lo piden. Tus tokens solo te cuentan a ti."],
  "Insufficient": ["不足", "Insuficiente"],
  "There is not yet a matched quota-and-cost window to compare.": ["尚无可比较的匹配额度与成本窗口。", "Aún no hay una ventana de cuota y coste coincidente para comparar."],
  "Not estimable": ["无法估算", "No estimable"],
  "No points fall inside this zoomed interval. Reset the view to return to the available evidence.": ["此缩放区间内没有数据点。请重置视图以返回可用证据。", "No hay puntos dentro de este intervalo ampliado. Restablece la vista para volver a la evidencia disponible."],
  "This historical calibration view has no per-window reset annotations. Treat it as diagnostic evidence, not a live allowance reading.": ["此历史校准视图没有逐窗口的重置注释。请将其视为诊断证据，而非实时额度读数。", "Esta vista histórica de calibración no tiene anotaciones de restablecimiento por ventana. Trátala como evidencia diagnóstica, no como una lectura de límite en vivo."],
  "No windows fall inside this date range.": ["此日期范围内没有窗口。", "No hay ventanas dentro de este intervalo de fechas."],
  "No weekly estimates loaded.": ["未加载每周估计。", "No se cargaron estimaciones semanales."],
  "Awaiting local evidence.": ["正在等待本地证据。", "A la espera de evidencia local."],
  "Saving your Codex speed mode…": ["正在保存你的 Codex 速度模式…", "Guardando tu modo de velocidad de Codex…"],
  "Connecting…": ["正在连接…", "Conectando…"],
  "No real usage is displayed": ["未显示真实使用情况", "No se muestra uso real"],
  "Starting local analysis…": ["正在开始本地分析…", "Iniciando análisis local…"],
  "Update running; reconnecting…": ["更新正在运行；正在重新连接…", "Actualización en curso; reconectando…"],
  "Continuing local analysis…": ["正在继续本地分析…", "Continuando el análisis local…"],
  "Finalizing bounded pause…": ["正在完成有界暂停…", "Finalizando la pausa limitada…"],
  "Loading saved results…": ["正在加载已保存结果…", "Cargando resultados guardados…"],
  "Loading updated evidence…": ["正在加载更新后的证据…", "Cargando evidencia actualizada…"],
  "Preparing locally…": ["正在本地准备…", "Preparando localmente…"],
  "Opening TiboTattle… If no app appears, install the signed Mac download above, then try again.": ["正在打开 TiboTattle…如果没有出现应用，请安装上方已签名的 Mac 下载，然后重试。", "Abriendo TiboTattle… Si no aparece la app, instala la descarga firmada para Mac de arriba y vuelve a intentarlo."],
  "Continue in the TiboTattle in-app window. If nothing opened, the app is not installed or macOS blocked the link.": ["请在 TiboTattle 应用内窗口继续。如果没有打开任何内容，说明应用未安装或 macOS 阻止了该链接。", "Continúa en la ventana integrada de TiboTattle. Si no se abrió nada, la app no está instalada o macOS bloqueó el enlace."],
  "Signed out on this page. Sign in again with Google or Apple when you want to contribute.": ["已在此页面退出登录。想继续贡献时，请使用 Google 或 Apple 再次登录。", "Sesión cerrada en esta página. Inicia sesión de nuevo con Google o Apple cuando quieras contribuir."],
  "Sign in first: hosted participation requires Google or Apple sign-in above. Local-only use needs no account, and nothing was uploaded.": ["请先登录：托管参与需要使用上方的 Google 或 Apple 登录。本地使用不需要帐户，也没有上传任何内容。", "Inicia sesión primero: la participación alojada requiere iniciar sesión arriba con Google o Apple. El uso solo local no necesita cuenta y no se cargó nada."],
  "Connected. Review the content-free result below before deciding whether to send it. Nothing will repeat automatically.": ["已连接。请在决定是否发送前审阅下方不含内容的结果。不会自动重复任何操作。", "Conectado. Revisa el resultado sin contenido de abajo antes de decidir si enviarlo. Nada se repetirá automáticamente."],
  "Nothing will be contributed. Your local reporting continues unchanged.": ["不会贡献任何内容。你的本地报告会继续保持不变。", "No se aportará nada. Tus informes locales continúan sin cambios."],
  "JavaScript is required to render local monitoring evidence.": ["需要 JavaScript 才能呈现本地监测证据。", "Se requiere JavaScript para mostrar evidencia de monitorización local."],
});

function normalizeText(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function legacyText(value, locale) {
  const normalized = normalizeText(value);
  const row = LEGACY_TEXT_CATALOG[normalized];
  if (!row) return value;
  const index = negotiateLocale(locale) === "zh-Hans" ? 0
    : negotiateLocale(locale) === "es" ? 1 : -1;
  if (index < 0) return value;
  const leading = String(value).match(/^\s*/u)?.[0] ?? "";
  const trailing = String(value).match(/\s*$/u)?.[0] ?? "";
  return `${leading}${row[index]}${trailing}`;
}

export function translateLegacyText(value, locale = DEFAULT_LOCALE) {
  return legacyText(value, locale);
}

function safeStorage(windowRef) {
  try {
    const storage = windowRef?.localStorage;
    if (!storage) return null;
    const probe = "__tibotattle_localization_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function hostConfiguration(windowRef) {
  const candidate = windowRef?.__TIBOTATTLE_LOCALIZATION__;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  return candidate.schemaVersion === LOCALIZATION_SCHEMA_VERSION ? candidate : null;
}

function hostPostMessage(windowRef, preference) {
  try {
    windowRef?.webkit?.messageHandlers?.tibotattleLocalization?.postMessage?.({
      type: "set-language-preference",
      preference,
    });
  } catch {
    // The embedded host is optional. A browser-only choice is still useful and
    // is persisted in browser storage when that storage is available.
  }
}

const SEMANTIC_ATTRIBUTE_SELECTOR = [
  "[data-i18n]",
  "[data-i18n-aria-label]",
  "[data-i18n-alt]",
  "[data-i18n-title]",
  "[data-i18n-placeholder]",
].join(", ");

function isSkippedLocalizationElement(element) {
  return element?.closest?.("[data-i18n-skip]") != null;
}

function isInsideLocalizationRoot(element) {
  return element?.closest?.("[data-i18n-root]") != null;
}

function isInsideLegacyRoot(element) {
  return element?.closest?.("[data-i18n-legacy-root]") != null;
}

function rootElements(documentRef) {
  return [...(documentRef?.querySelectorAll?.("[data-i18n-root]") ?? [])]
    .filter((element) => !isSkippedLocalizationElement(element));
}

function legacyRootElements(documentRef) {
  return [...(documentRef?.querySelectorAll?.("[data-i18n-legacy-root]") ?? [])]
    .filter((element) =>
      isInsideLocalizationRoot(element) && !isSkippedLocalizationElement(element)
    );
}

function semanticElements(root) {
  if (!root) return [];
  const candidates = [];
  if (root.nodeType === 1 && root.matches?.(SEMANTIC_ATTRIBUTE_SELECTOR)) {
    candidates.push(root);
  }
  candidates.push(
    ...(root.querySelectorAll?.(SEMANTIC_ATTRIBUTE_SELECTOR) ?? []),
  );
  return candidates.filter((element) =>
    isInsideLocalizationRoot(element) && !isSkippedLocalizationElement(element)
  );
}

function textNodes(root) {
  if (!root?.ownerDocument && root?.nodeType !== 9) return [];
  const documentRef = root.nodeType === 9 ? root : root.ownerDocument;
  if (typeof documentRef.createTreeWalker !== "function") return [];
  const nodeFilter = documentRef.defaultView?.NodeFilter ?? globalThis.NodeFilter;
  if (!nodeFilter) return [];
  const walker = documentRef.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent
          || !isInsideLegacyRoot(parent)
          || isSkippedLocalizationElement(parent)
          || parent.closest?.("[data-i18n]")
          || ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "PRE", "CODE", "KBD", "SAMP"].includes(parent.tagName)) {
        return nodeFilter.FILTER_REJECT;
      }
      return normalizeText(node.nodeValue).length === 0
        ? nodeFilter.FILTER_REJECT
        : nodeFilter.FILTER_ACCEPT;
    },
  });
  const result = [];
  while (walker.nextNode()) result.push(walker.currentNode);
  return result;
}

/**
 * Create one localizer per document. Message language is selected from a
 * native handoff when present; formatting locale remains a separate, regional
 * value so a translation choice cannot change event-time or pricing meaning.
 */
export function createBrowserLocalization({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
} = {}) {
  const host = hostConfiguration(windowRef);
  const storage = safeStorage(windowRef);
  const browserLanguages = Array.isArray(windowRef?.navigator?.languages)
    ? windowRef.navigator.languages
    : [windowRef?.navigator?.language].filter(Boolean);
  const systemLanguages = Array.isArray(host?.preferredLanguages)
    ? host.preferredLanguages
    : browserLanguages;
  const formatLocale = canonicalLocale(host?.formatLocale)
    ?? canonicalLocale(browserLanguages[0])
    ?? DEFAULT_LOCALE;
  let preference = host?.host === "native"
    ? host.languagePreference
    : storage?.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY)
      ?? host?.languagePreference
      ?? SYSTEM_LANGUAGE_PREFERENCE;
  if (!isLanguagePreference(preference)) preference = SYSTEM_LANGUAGE_PREFERENCE;
  let locale = preference === SYSTEM_LANGUAGE_PREFERENCE
    ? negotiateLocale(systemLanguages)
    : negotiateLocale(preference);
  let observer = null;
  const originalTextNodes = new WeakMap();
  const staticLegacyTextNodes = new Set();
  const ownedLegacyText = new Map();

  const t = (key, values = {}) => translate(key, values, locale);
  const tPlural = (key, count, values = {}) =>
    translatePlural(key, count, values, locale);

  function setTextIfChanged(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function localizeElementAttributes(root) {
    for (const element of semanticElements(root)) {
      if (element.dataset.i18n) setTextIfChanged(element, t(element.dataset.i18n));
      if (element.dataset.i18nAriaLabel) {
        const value = t(element.dataset.i18nAriaLabel);
        if (element.getAttribute("aria-label") !== value) {
          element.setAttribute("aria-label", value);
        }
      }
      if (element.dataset.i18nAlt) {
        const value = t(element.dataset.i18nAlt);
        if (element.getAttribute("alt") !== value) {
          element.setAttribute("alt", value);
        }
      }
      if (element.dataset.i18nTitle) {
        const value = t(element.dataset.i18nTitle);
        if (element.title !== value) element.title = value;
      }
      if (element.dataset.i18nPlaceholder) {
        const value = t(element.dataset.i18nPlaceholder);
        if (element.getAttribute("placeholder") !== value) {
          element.setAttribute("placeholder", value);
        }
      }
    }
  }

  function updateDocumentLanguage() {
    if (documentRef?.documentElement) {
      documentRef.documentElement.lang = locale;
      documentRef.documentElement.dir = directionForLocale(locale);
    }
  }

  // Exact-text translation is a bounded migration bridge for product-owned
  // UI roots only. Raw provider/user data must always sit beneath
  // `data-i18n-skip`; that boundary is deliberately checked before a node is
  // remembered, and again before it is rewritten.
  function registerLegacyText(root) {
    for (const node of textNodes(root)) {
      if (!originalTextNodes.has(node)) {
        originalTextNodes.set(node, node.nodeValue);
      }
      staticLegacyTextNodes.add(node);
    }
  }

  function captureStaticLegacyText() {
    for (const root of legacyRootElements(documentRef)) registerLegacyText(root);
  }

  function localizeRegisteredLegacyText() {
    for (const node of staticLegacyTextNodes) {
      if (!node.isConnected || !node.parentElement
          || !isInsideLegacyRoot(node.parentElement)
          || isSkippedLocalizationElement(node.parentElement)) {
        staticLegacyTextNodes.delete(node);
        continue;
      }
      const original = originalTextNodes.get(node);
      if (original === undefined) continue;
      const next = legacyText(original, locale);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    for (const [element, original] of ownedLegacyText) {
      if (!element.isConnected
          || !isInsideLegacyRoot(element)
          || isSkippedLocalizationElement(element)) {
        ownedLegacyText.delete(element);
        continue;
      }
      setTextIfChanged(element, legacyText(original, locale));
    }
  }

  function setLegacyText(element, value) {
    if (!element || typeof value !== "string") return;
    ownedLegacyText.set(element, value);
    setTextIfChanged(element, legacyText(value, locale));
  }

  function localizeTree(root = null) {
    updateDocumentLanguage();
    if (root) {
      localizeElementAttributes(root);
      registerLegacyText(root);
    } else {
      for (const staticRoot of rootElements(documentRef)) {
        localizeElementAttributes(staticRoot);
      }
      for (const legacyRoot of legacyRootElements(documentRef)) {
        registerLegacyText(legacyRoot);
      }
    }
    localizeRegisteredLegacyText();
  }

  function installMutationObserver() {
    if (!documentRef?.documentElement
        || typeof windowRef?.MutationObserver !== "function"
        || observer !== null) return;
    observer = new windowRef.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          localizeElementAttributes(mutation.target);
          continue;
        }
        if (mutation.type === "characterData") {
          if (mutation.target.parentElement
              && isInsideLegacyRoot(mutation.target.parentElement)
              && !isSkippedLocalizationElement(mutation.target.parentElement)) {
            registerLegacyText(mutation.target.parentElement);
            localizeRegisteredLegacyText();
          }
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) {
            localizeElementAttributes(node);
            registerLegacyText(node);
          } else if (node.nodeType === 3 && node.parentElement
              && isInsideLegacyRoot(node.parentElement)
              && !isSkippedLocalizationElement(node.parentElement)) {
            registerLegacyText(node.parentElement);
          }
        }
      }
    });
    observer.observe(documentRef.documentElement, {
      attributes: true,
      attributeFilter: [
        "data-i18n",
        "data-i18n-aria-label",
        "data-i18n-title",
        "data-i18n-placeholder",
      ],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function languageOptionLabel(option) {
    if (option.id === SYSTEM_LANGUAGE_PREFERENCE) return t("language.system");
    return option.nativeLabel;
  }

  function bindLanguagePicker(element) {
    if (!element) return;
    const wasBound = element.dataset.tibotattleLanguagePicker === "true";
    if (!wasBound) {
      element.dataset.tibotattleLanguagePicker = "true";
      element.addEventListener("change", () => setLanguagePreference(element.value));
    }
    // The self-identifying choices stay recoverable, while the system option
    // itself follows the active UI language. Rebuild option text on every
    // locale refresh without registering a second change handler.
    element.replaceChildren();
    for (const option of LANGUAGE_OPTIONS) {
      const node = documentRef.createElement("option");
      node.value = option.id;
      node.textContent = languageOptionLabel(option);
      element.append(node);
    }
    element.value = preference;
  }

  function refreshLanguagePickers() {
    for (const element of documentRef?.querySelectorAll?.("[data-language-picker]") ?? []) {
      bindLanguagePicker(element);
      element.value = preference;
      element.setAttribute("aria-label", t("language.label"));
    }
  }

  function announceLanguageChange() {
    const option = LANGUAGE_OPTIONS.find(({ id }) => id === preference);
    const language = option ? languageOptionLabel(option) : locale;
    const message = t("language.changed", { language });
    for (const element of documentRef?.querySelectorAll?.("[data-language-announcement]") ?? []) {
      if (!isSkippedLocalizationElement(element)) setTextIfChanged(element, message);
    }
  }

  function setLanguagePreference(
    nextPreference,
    { notifyHost = true, announce = true } = {},
  ) {
    const next = isLanguagePreference(nextPreference)
      ? nextPreference
      : SYSTEM_LANGUAGE_PREFERENCE;
    preference = next;
    locale = preference === SYSTEM_LANGUAGE_PREFERENCE
      ? negotiateLocale(systemLanguages)
      : negotiateLocale(preference);
    try {
      storage?.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, preference);
    } catch {
      // Browser storage can be disabled. The in-memory choice remains active.
    }
    localizeTree();
    refreshLanguagePickers();
    if (announce) announceLanguageChange();
    if (notifyHost && host?.host === "native") hostPostMessage(windowRef, preference);
    windowRef?.dispatchEvent?.(new CustomEvent("tibotattle:locale-change", {
      detail: Object.freeze({ formatLocale, locale, preference }),
    }));
  }

  windowRef?.addEventListener?.("tibotattle:locale-override", (event) => {
    const next = event?.detail?.preference;
    if (isLanguagePreference(next)) setLanguagePreference(next, { notifyHost: false });
  });

  captureStaticLegacyText();
  localizeTree();
  refreshLanguagePickers();
  installMutationObserver();
  return Object.freeze({
    bindLanguagePicker,
    direction: () => directionForLocale(locale),
    formatLocale: () => formatLocale,
    languageOptionLabel,
    locale: () => locale,
    localizeTree,
    preference: () => preference,
    setLegacyText,
    setLanguagePreference,
    t,
    tPlural,
    translateText: (value) => legacyText(value, locale),
  });
}
