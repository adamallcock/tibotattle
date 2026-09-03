// Shared browser-side localization policy for the loopback dashboard and the
// public community site. Its canonical catalog mirror ships locally: both
// surfaces are shipped as ordinary static ES modules, and a locale choice must
// work while the local companion is offline.

import { CATALOGS } from "./i18n.generated.js";

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

// Mirrors `MODEL_COMPOSITION_POLICY.minimumModelCostShare` in the composition
// kernel: a model under this share of the fitted mix is never given a free
// parameter of its own and is priced at the pooled remainder rate instead.
// Same provenance rule as the two gates above - guarded by a source contract
// test, because the per-model card states this threshold to the reader.
// Moved 2 -> 3 with the kernel on 2026-08-20; the contract test is what caught
// the drift, which is exactly what it is for.
export const COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT = 3;

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
  ...Object.fromEntries(Object.keys(CATALOGS[DEFAULT_LOCALE])
    .filter((key) => key.startsWith("contribution."))
    .map((key) => [key, SUPPORTED_LOCALES.map((locale) => CATALOGS[locale][key])])),
  "language.label": ["Language", "语言", "Idioma"],
  "language.system": ["System", "跟随系统", "Sistema"],
  "language.english": ["English", "English", "English"],
  "language.simplifiedChinese": ["Simplified Chinese", "简体中文", "Chino simplificado"],
  "language.spanish": ["Spanish", "Español", "Español"],
  "language.changed": ["Language changed to {language}.", "语言已切换为{language}。", "Idioma cambiado a {language}."],
  "status.fresh": ["Fresh", "最新", "Actualizado"],
  "status.indexingHistory": ["Indexing history · {indexed} of {total}", "正在索引历史 · {indexed}/{total}", "Indexando historial · {indexed} de {total}"],
  "status.historyPartial": ["History coverage · {skipped} unavailable", "历史覆盖范围 · {skipped} 个来源不可用", "Cobertura del historial · {skipped} no disponibles"],
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
  // The provider's separate Spark limit now reports two windows at once (the
  // re-introduced 5-hour "Codex Spark" window and its seven-day window), so
  // each recognized duration carries its own title while windowSpark stays the
  // honest generic name for any unfamiliar Spark duration.
  "dashboard.quota.windowSparkFiveHour": ["Spark five-hour allowance", "Spark 五小时额度", "Asignación de Spark de cinco horas"],
  "dashboard.quota.windowSparkSevenDay": ["Spark seven-day allowance", "Spark 七天额度", "Asignación de Spark de siete días"],
  "dashboard.quota.spark": ["Spark · separate limit", "Spark · 独立额度", "Spark · límite separado"],
  "dashboard.quota.windowProviderReported": ["Provider-reported {duration} window", "提供方报告的 {duration} 窗口", "Ventana de {duration} informada por el proveedor"],
  "dashboard.quota.windowOther": ["Other observed allowance", "其他观测到的额度", "Otra asignación observada"],
  "dashboard.quota.windowOtherDuration": ["Other observed {duration} allowance", "其他观测到的 {duration}额度", "Otra asignación observada de {duration}"],
  "dashboard.quota.windowNamedObserved": ["{name} · {duration} allowance", "{name} · {duration}额度", "{name} · asignación de {duration}"],
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
  // The overview card's coverage/method/provenance metadata line was removed
  // (owner-directed, 2026-08-10), and its keys with it. Coverage honesty
  // remains in the history-progress keys below, the accounting.pricing.*
  // sentences, and the routed evidence warnings.
  "dashboard.pricing.noComponents": ["No token-component accounting was returned.", "未返回令牌组件核算。", "No se devolvió contabilidad por componente de token."],
  "dashboard.pricing.tokens": ["{count} tokens", "{count} 个令牌", "{count} tokens"],
  "accounting.projection.newerBuild": ["This history was created by a newer TiboTattle build. Install a compatible newer build to refresh it. Your retained local history has not been deleted.", "此历史记录由较新版本的 TiboTattle 创建。请安装兼容的较新版本以刷新它。保留的本地历史记录尚未被删除。", "Este historial fue creado por una versión más reciente de TiboTattle. Instala una versión posterior compatible para actualizarlo. El historial local conservado no se ha eliminado."],
  "accounting.projection.unavailable": ["Usage accounting is unavailable. The dash is intentional; missing evidence is not zero usage.", "使用情况核算不可用。破折号是有意显示的；缺失证据并不代表使用量为零。", "La contabilidad de uso no está disponible. El guion es intencional: la falta de evidencia no significa uso cero."],
  "accounting.projection.lastVerifiedPeriod": ["Last verified · {period}", "上次验证 · {period}", "Última verificación · {period}"],
  "accounting.projection.periodUnavailable": ["Period unavailable", "期间不可用", "Período no disponible"],
  "accounting.projection.lastVerifiedMetric": ["Last-verified API-price equivalent", "上次验证的 API 价格等值", "Equivalente a precio de API verificado por última vez"],
  "accounting.projection.metricUnavailable": ["Usage accounting unavailable", "使用情况核算不可用", "Contabilidad de uso no disponible"],
  "accounting.projection.retainedComponents": ["Component detail is not available in this bounded last-verified view.", "此有限的上次验证视图中没有组件明细。", "El detalle por componentes no está disponible en esta vista limitada de la última verificación."],
  "accounting.projection.componentsUnavailable": ["Token-component accounting is unavailable; this is not a measured zero.", "令牌组件核算不可用；这不是测得的零值。", "La contabilidad por componente de token no está disponible; no es un cero medido."],
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
  "dashboard.history.partialHeadline": [
    "Local history available · {sources} unavailable",
    "本地历史可用 · {sources} 不可用",
    "Historial local disponible · {sources} no disponibles",
  ],
  "dashboard.history.partialSources": [
    "Indexed {indexed} of {total} discovered sources ({bytesIndexed} of {bytesTotal}). Verified figures leave out {sources} that did not pass local validation; the coverage limit remains explicit.",
    "已索引 {total} 个已发现来源中的 {indexed} 个（{bytesIndexed}/{bytesTotal}）。已验证的数字不包含未通过本地验证的 {sources}；覆盖范围限制会保持明确标示。",
    "Fuentes indexadas: {indexed} de {total} ({bytesIndexed} de {bytesTotal}). Las cifras verificadas no incluyen {sources} que no superaron la validación local; el límite de cobertura permanece explícito.",
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
  "refresh.degradedLoading": [
    "Loading verified partial evidence…",
    "正在加载已验证的部分证据…",
    "Cargando evidencia parcial verificada…",
  ],
  "refresh.degradedTitle": [
    "Local analysis complete with limited history coverage",
    "本地分析已完成，历史覆盖范围有限",
    "Análisis local completo con cobertura de historial limitada",
  ],
  "refresh.degradedCopy": [
    "Verified totals remain available. TiboTattle left out {sources} across {threads} that did not pass local validation; no missing usage is shown as zero. Update again after the source files change, or whenever you want to check.",
    "已验证的总计仍然可用。TiboTattle 未包含 {threads} 中未通过本地验证的 {sources}；任何缺失用量都不会显示为零。来源文件发生变化后，或你想再次检查时，可以再次更新。",
    "Los totales verificados siguen disponibles. TiboTattle dejó fuera {sources} de {threads} que no superaron la validación local; ningún uso ausente se muestra como cero. Actualiza de nuevo cuando cambien los archivos de origen o cuando quieras comprobarlo.",
  ],
  "refresh.degradedGenericCopy": [
    "Verified headline evidence remains available, but the unified history step ended in a fixed degraded state ({code}). Automatic retries have stopped; an explicit retry remains available.",
    "已验证的概要证据仍然可用，但统一历史步骤以固定的降级状态结束（{code}）。自动重试已停止；仍可明确重试。",
    "La evidencia resumida verificada sigue disponible, pero el paso de historial unificado terminó en un estado degradado fijo ({code}). Los reintentos automáticos se han detenido; aún puedes reintentar expresamente.",
  ],
  "refresh.alreadyRunningTitle": ["An update is already running", "更新正在进行中", "Ya hay una actualización en curso"],
  "refresh.alreadyRunningCopy": [
    "This request did not start another update. Your current results remain available; when the current update finishes, choose Refresh again if detailed accounting still needs updating.",
    "此请求没有启动另一次更新。当前结果仍然可用；当前更新完成后，如果详细核算仍需更新，请再次选择“刷新”。",
    "Esta solicitud no inició otra actualización. Tus resultados actuales siguen disponibles; cuando termine la actualización en curso, elige Actualizar de nuevo si la contabilidad detallada aún necesita actualizarse.",
  ],
  // Why the replay-safe accounting artifacts are missing when the rebuild has
  // deferred repeatedly: the rebuild misses its memory ceiling, softly, and
  // retries — this names the cause and the streak instead of showing bare
  // zeros with no explanation.
  "accounting.rebuildDeferred.persistent": [
    "The fuller cost-accounting rebuild has been postponed {count} times in a row because it would push the app past its memory ceiling. It retries automatically; restarting the menu-bar app frees memory and usually lets the next attempt complete.",
    "更完整的成本核算重建已连续推迟 {count} 次，因为它会使应用超出内存上限。应用会自动重试；重启菜单栏应用可释放内存，通常能让下一次尝试完成。",
    "La reconstrucción más completa de la contabilidad de costes se ha pospuesto {count} veces seguidas porque llevaría la aplicación más allá de su límite de memoria. Se reintenta automáticamente; reiniciar la aplicación de la barra de menús libera memoria y normalmente permite completar el siguiente intento.",
  ],
  // Quiet informational label on figures served from the previous app
  // version's cache while the current version's local rebuild is still
  // running. Deliberately not alert-styled: the numbers are the user's own
  // history, merely computed by the prior semantics, and the recalculation is
  // automatic. The "retrying" variant appears once the rebuild has deferred
  // repeatedly, wiring the live rebuild state into the same label instead of
  // adding a second banner.
  "accounting.staleServe.recalculating": [
    "Computed by the previous version — recalculating now.",
    "由先前版本计算——正在重新计算。",
    "Calculado por la versión anterior — recalculando ahora.",
  ],
  "accounting.staleServe.retrying": [
    "Computed by the previous version — the recalculation is being retried.",
    "由先前版本计算——正在重试重新计算。",
    "Calculado por la versión anterior — se está reintentando el recálculo.",
  ],
  "accounting.staleServe.newerBuild": [
    "Last verified by a compatible build — this older build cannot refresh the newer local history.",
    "由兼容版本完成上次验证——此旧版本无法刷新较新的本地历史记录。",
    "Última verificación realizada por una versión compatible; esta versión anterior no puede actualizar el historial local más reciente.",
  ],
  "accounting.staleServe.lastVerified": [
    "Showing the last verified local projection because the current history could not be read.",
    "由于无法读取当前历史记录，正在显示上次验证的本地投影。",
    "Se muestra la última proyección local verificada porque no se pudo leer el historial actual.",
  ],
  "accounting.staleServe.metricLabel": [
    "API-price equivalent (previous version)",
    "API 价格等值（先前版本）",
    "Equivalente a precio de API (versión anterior)",
  ],
 "accounting.pricing.partialCoverage": ["{percent} of usage changes have a reviewed price; coverage is partial.", "使用变化中有 {percent} 使用了经审核的价格；覆盖率不完整。", "El {percent} de los cambios de uso tiene un precio revisado; la cobertura es parcial."],
 "accounting.pricing.coverageReviewed": ["All usage changes in this period have reviewed pricing.", "此期间的所有使用变化都有经审核的价格。", "Todos los cambios de uso de este período tienen precios revisados."],
  "accounting.pricing.coverageShort": ["{percent} coverage", "{percent} 覆盖率", "{percent} de cobertura"],
  "accounting.cacheImpact.subtotalValue": ["Subtotal {amount}", "小计 {amount}", "Subtotal {amount}"],
  "accounting.cacheImpact.subtotalScope": ["Covered/priced subtotal; included drops: {priced}. Not a whole-period total.", "已覆盖且已定价的小计；计入的下降：{priced} 次。并非整个期间的总额。", "Subtotal con cobertura y precio; caídas incluidas: {priced}. No es el total del período completo."],
  "accounting.cacheImpact.subtotalStandard": ["Standard API equivalent for the same covered/priced drops: {amount}.", "同一组已覆盖且已定价下降的 Standard API 等价值：{amount}。", "Equivalente de API Standard de las mismas caídas con cobertura y precio: {amount}."],
  "accounting.cacheImpact.subtotalStandardOnly": ["Subtotal shown at Standard API rates: {amount}; speed-priced accounting is unavailable.", "按 Standard API 费率显示小计：{amount}；按速度档定价的核算不可用。", "Subtotal con tarifas de API Standard: {amount}; la contabilidad según velocidad no está disponible."],
  "accounting.cacheImpact.subtotalUnpriced": ["Drops excluded for incomplete prices: {unpriced}.", "因价格不完整而排除的下降：{unpriced} 次。", "Caídas excluidas por precios incompletos: {unpriced}."],
  "accounting.cacheSwitch.metricLabel": ["Possible switch overhead", "可能的切换开销", "Posible coste adicional al cambiar"],
  "accounting.cacheSwitch.metricExplanation": ["A material drop means cache-read tokens fell to at most half the prior request within five minutes, with prior cache-read evidence required. The cache-read drop is observed; its relationship to the adjacent model or reasoning change is inferred. The headline applies the recorded or selected Codex speed and reviewed Fast multiplier to the conservative Standard-price premium. It is not a bill or provider-published allowance.", "大幅下降是指在具有先前缓存读取证据的前提下，缓存读取令牌在五分钟内降至上一请求的一半或更少。缓存读取量的下降是观测结果；它与相邻模型或推理强度更改之间的关系是推断结果。标题金额会把已记录或所选的 Codex 速度以及经审核的 Fast 倍数应用于保守的 Standard 价格溢价。它不是账单或提供方公布的额度。", "Una caída material significa que los tokens de lectura de caché bajaron como máximo a la mitad de la solicitud anterior en cinco minutos, y requiere evidencia previa de lectura de caché. La caída se observa; su relación con el cambio adyacente se infiere. La cifra principal aplica la velocidad de Codex registrada o seleccionada y el multiplicador Fast revisado a la prima conservadora con precio Standard. No es una factura ni una cuota publicada por el proveedor."],
  "accounting.cacheSwitch.noteUnavailable": ["This period was not evaluated.", "此期间未进行评估。", "Este período no se evaluó."],
  "accounting.cacheSwitch.noteIncomplete": ["Whole-period total unavailable. Configuration changes without compaction-aware boundary coverage: {uncovered}.", "整个期间的总额不可用。缺少可识别上下文压缩的边界覆盖的配置更改：{uncovered} 次。", "Total del período completo no disponible. Cambios de configuración sin cobertura de límites que reconozca las compactaciones: {uncovered}."],
  "accounting.cacheSwitch.noteIncompleteOrdering": ["Partial estimate; excluded sessions with uncertain event order: {ordering}.", "部分估算；因事件顺序不确定而排除的会话：{ordering} 个。", "Estimación parcial; sesiones excluidas por un orden de eventos incierto: {ordering}."],
  "accounting.cacheSwitch.noteIncompleteCombined": ["Whole-period total unavailable. Configuration changes without compaction-aware boundaries: {uncovered}; sessions without exact local event order: {ordering}.", "整个期间的总额不可用。缺少可识别上下文压缩的边界的配置更改：{uncovered} 次；缺少精确本地事件顺序的会话：{ordering} 个。", "Total del período completo no disponible. Cambios de configuración sin límites que reconozcan las compactaciones: {uncovered}; sesiones sin orden local exacto de eventos: {ordering}."],
  "accounting.cacheSwitch.noteZero": ["{proximate} proximate configuration changes recorded · no material cache-read drop observed", "记录了 {proximate} 次相近的配置更改 · 未观测到缓存读取量大幅下降", "Se registraron {proximate} cambios de configuración próximos · no se observó ninguna caída material de lectura de caché"],
  "accounting.cacheSwitch.noteObserved": ["{drops} material cache-read drops among {proximate} proximate configuration changes.", "{proximate} 次相近的配置更改中有 {drops} 次缓存读取量大幅下降。", "{drops} caídas materiales de lectura de caché entre {proximate} cambios de configuración próximos."],
  "accounting.cacheSwitch.notePartialPricing": ["Only {priced} of {total} drops had reviewed pricing; the whole-period total is unavailable.", "{total} 次下降中只有 {priced} 次有经审核的价格；整个期间的总额不可用。", "Solo {priced} de {total} caídas tenían precios revisados; el total del período completo no está disponible."],
  "accounting.cacheSwitch.noteUnpriced": ["No complete price estimate is available for these drops.", "这些下降没有完整的价格估算。", "No hay una estimación de precio completa para estas caídas."],
  "accounting.cacheSwitch.allowanceMedian": ["Conditional historical allowance estimate (may combine accounts): about {median} percentage points.", "条件性历史额度估计（可能合并多个帐户）：约 {median} 个百分点。", "Estimación histórica condicional de cuota (puede combinar cuentas): unos {median} puntos porcentuales."],
  "accounting.cacheSwitch.allowanceRange": ["Conditional historical allowance range (may combine accounts): {lower}–{upper} percentage points.", "条件性历史额度范围（可能合并多个帐户）：{lower}–{upper} 个百分点。", "Intervalo histórico condicional de cuota (puede combinar cuentas): {lower}–{upper} puntos porcentuales."],
  "accounting.cacheSwitch.standardPremium": ["Standard-rate accounting equivalent before Fast weighting: {amount}.", "应用 Fast 加权前的 Standard 费率记账等价值：{amount}。", "Equivalente contable con tarifa Standard antes de la ponderación Fast: {amount}."],
  "accounting.cacheSwitch.detailsSummary": ["See possible switch overhead", "查看可能的切换开销", "Ver el posible coste adicional al cambiar"],
  "accounting.cacheSwitch.detailsExplanation": ["These recent rows pair an adjacent model or reasoning change with an observed material cache-read drop within five minutes. The cache-read change is observed; its relationship to the setting change is inferred.", "这些近期记录将相邻的模型或推理强度更改与五分钟内观测到的缓存读取量大幅下降配对。缓存读取量的变化是观测结果；它与设置更改之间的关系是推断结果。", "Estas filas recientes emparejan un cambio adyacente de modelo o razonamiento con una caída material observada de lectura de caché en un plazo de cinco minutos. El cambio de lectura de caché se observa; su relación con el cambio de configuración se infiere."],
  "accounting.cacheSwitch.detailsEmpty": ["No qualifying material cache-read drops in this period.", "此期间没有符合条件的缓存读取量大幅下降。", "No hay caídas materiales de lectura de caché que cumplan los requisitos en este período."],
  "accounting.cacheSwitch.tableCaption": ["Recent covered switch-overhead comparisons at Standard API rates; not a period total", "近期已覆盖的切换开销比较，按 Standard API 费率计算；并非期间总额", "Comparaciones recientes con cobertura del coste al cambiar, con tarifas de API Standard; no es un total del período"],
  "accounting.cacheDropThread.column": ["Thread name", "会话名称", "Nombre de la conversación"],
  "accounting.cacheDropThread.unavailable": ["Thread unavailable", "会话不可用", "Conversación no disponible"],
  "accounting.cacheDropThread.fallback": ["Thread {id}", "会话 {id}", "Conversación {id}"],
  "accounting.cacheDropThread.subworker": ["{name} subworker", "{name} 子任务", "{name}, subagente"],
  "accounting.cacheDropThread.localTime": ["Local time: {time}", "本地时间：{time}", "Hora local: {time}"],
  "accounting.cacheDropThread.open": ["Open {name} in Codex. {time}", "在 Codex 中打开 {name}。{time}", "Abrir {name} en Codex. {time}"],
  "accounting.cacheSwitch.column.change": ["Configuration change", "配置更改", "Cambio de configuración"],
  "accounting.cacheSwitch.column.cacheRead": ["Cache read", "缓存读取", "Lectura de caché"],
  "accounting.cacheSwitch.column.lostTokens": ["Est. lost reuse", "估算的复用损失", "Reutilización perdida estimada"],
  "accounting.cacheSwitch.column.apiEquivalent": ["API equivalent", "API 等值", "Equivalente de API"],
  "accounting.cacheSwitch.change.model": ["Model: {previous} → {current}", "模型：{previous} → {current}", "Modelo: {previous} → {current}"],
  "accounting.cacheSwitch.change.reasoning": ["Reasoning: {previous} → {current}", "推理强度：{previous} → {current}", "Razonamiento: {previous} → {current}"],
  "accounting.cacheSwitch.change.both": ["Model + reasoning: {previousModel} / {previousEffort} → {currentModel} / {currentEffort}", "模型和推理强度：{previousModel} / {previousEffort} → {currentModel} / {currentEffort}", "Modelo y razonamiento: {previousModel} / {previousEffort} → {currentModel} / {currentEffort}"],
  "accounting.cacheSwitch.effort.none": ["None", "无", "Ninguno"],
  "accounting.cacheSwitch.effort.minimal": ["Minimal", "最低", "Mínimo"],
  "accounting.cacheSwitch.effort.low": ["Low", "低", "Bajo"],
  "accounting.cacheSwitch.effort.medium": ["Medium", "中", "Medio"],
  "accounting.cacheSwitch.effort.high": ["High", "高", "Alto"],
  "accounting.cacheSwitch.effort.xhigh": ["Extra high", "极高", "Extraalto"],
  "accounting.cacheSwitch.effort.max": ["Max", "Max", "Máximo"],
  "accounting.cacheSwitch.effort.ultra": ["Ultra", "Ultra", "Ultra"],
  "accounting.cacheSwitch.effort.unknown": ["Unknown", "未知", "Desconocido"],
  "accounting.cacheContinuity.metricLabel": ["Possible cache-continuity overhead", "可能的缓存连续性开销", "Posible coste adicional de continuidad de caché"],
  "accounting.cacheContinuity.metricExplanation": ["A conservative estimate for material cache-read drops between adjacent user turns while the effective model, reasoning, routing, and surface stayed unchanged. Elapsed time is evidence rather than an eligibility rule. The headline uses recorded or selected Codex speed weighting when available and otherwise shows the Standard API equivalent before Fast weighting; recorded compactions, contracted contexts, and incomplete boundary coverage are excluded or withheld. It is not a bill or provider-published allowance.", "保守估算：在相邻用户轮次之间，有效模型、推理强度、路由和界面均未改变，但缓存读取量大幅下降。经过时间仅作为证据，而不是资格规则。如有可用的已记录或所选 Codex 速度权重，标题金额会采用该权重；否则显示应用 Fast 加权前的 Standard API 等价值。已记录的上下文压缩、收缩的上下文以及不完整的边界覆盖会被排除或暂缓显示。它不是账单或提供方公布的额度。", "Estimación conservadora de caídas materiales de lectura de caché entre turnos adyacentes sin cambios de modelo, razonamiento, enrutamiento ni superficie. El tiempo es evidencia, no una regla de inclusión. La cifra principal usa la ponderación de velocidad de Codex registrada o seleccionada cuando está disponible y, en caso contrario, muestra el equivalente de API Standard antes de la ponderación Fast; las compactaciones, los contextos reducidos y la cobertura incompleta se excluyen o se omiten. No es una factura ni una cuota publicada por el proveedor."],
  "accounting.cacheContinuity.noteUnavailable": ["This period was not evaluated.", "此期间未进行评估。", "Este período no se evaluó."],
  "accounting.cacheContinuity.noteIncomplete": ["Whole-period total unavailable. Returns without compaction-aware boundary coverage: {uncovered}.", "整个期间的总额不可用。缺少可识别上下文压缩的边界覆盖的返回：{uncovered} 次。", "Total del período completo no disponible. Retornos sin cobertura de límites que reconozca las compactaciones: {uncovered}."],
  "accounting.cacheContinuity.noteIncompleteOrdering": ["Partial estimate; excluded sessions with uncertain event order: {ordering}.", "部分估算；因事件顺序不确定而排除的会话：{ordering} 个。", "Estimación parcial; sesiones excluidas por un orden de eventos incierto: {ordering}."],
  "accounting.cacheContinuity.noteIncompleteCombined": ["Whole-period total unavailable. Returns without compaction-aware boundaries: {uncovered}; sessions without exact local event order: {ordering}.", "整个期间的总额不可用。缺少可识别上下文压缩的边界的返回：{uncovered} 次；缺少精确本地事件顺序的会话：{ordering} 个。", "Total del período completo no disponible. Retornos sin límites que reconozcan las compactaciones: {uncovered}; sesiones sin orden local exacto de eventos: {ordering}."],
  "accounting.cacheContinuity.noteZero": ["{comparable} comparable same-configuration turn pairs · no material cache-read drop observed", "{comparable} 对配置相同的可比较轮次 · 未观测到缓存读取量大幅下降", "{comparable} pares de turnos comparables con la misma configuración · no se observó ninguna caída material de lectura de caché"],
  "accounting.cacheContinuity.noteObserved": ["{drops} material cache-read drops among {comparable} comparable same-configuration turn pairs.", "{comparable} 对配置相同的可比较轮次中有 {drops} 次缓存读取量大幅下降。", "{drops} caídas materiales de lectura de caché entre {comparable} pares de turnos comparables con la misma configuración."],
  "accounting.cacheContinuity.noteUnpriced": ["Only {priced} of {total} drops had reviewed pricing; the whole-period total is unavailable.", "{total} 次下降中只有 {priced} 次有经审核的价格；整个期间的总额不可用。", "Solo {priced} de {total} caídas tenían precios revisados; el total del período completo no está disponible."],
  "accounting.cacheContinuity.noteCompaction": ["Kept separate: {drops} material drops across {requests} post-compaction requests; no old-prefix cost is assigned.", "单独列出：{requests} 次上下文压缩后请求中有 {drops} 次大幅下降；未分配旧前缀成本。", "Se mantienen aparte: {drops} caídas materiales en {requests} solicitudes posteriores a una compactación; no se asigna un coste al prefijo anterior."],
  "accounting.cacheContinuity.noteStandardFallback": ["Headline shown at Standard API rates before Fast weighting.", "标题按应用 Fast 加权前的 Standard API 费率显示。", "La cifra principal se muestra con tarifas de API Standard antes de la ponderación Fast."],
  "accounting.cacheContinuity.detailsSummary": ["See recent large cache drops", "查看近期缓存大幅下降", "Ver las caídas grandes de caché recientes"],
  "accounting.cacheContinuity.outcome.eyebrow": ["Cache reuse between turns", "轮次之间的缓存复用", "Reutilización de caché entre turnos"],
  "accounting.cacheContinuity.outcome.heading": ["Did the cache carry over?", "缓存延续了吗？", "¿Se conservó la caché?"],
  "accounting.cacheContinuity.outcome.subtitle": ["Follow-up turns with the same model and settings, grouped by time since the previous turn.", "按距上一个轮次的时间，对模型和设置相同的后续轮次进行分组。", "Turnos de seguimiento con el mismo modelo y la misma configuración, agrupados por el tiempo desde el turno anterior."],
  "accounting.cacheContinuity.outcome.moreLabel": ["reused more than half", "复用了超过一半", "reutilizaron más de la mitad"],
  "accounting.cacheContinuity.outcome.lessLabel": ["reused half or less", "复用了一半或更少", "reutilizaron la mitad o menos"],
  "accounting.cacheContinuity.outcome.overheadLabel": ["estimated overhead from cache drops", "缓存下降的估算开销", "coste estimado de las caídas de caché"],
  "accounting.cacheContinuity.outcome.overheadBasis": ["Standard API equivalent", "Standard API 等价值", "Equivalente de API Standard"],
  "accounting.cacheContinuity.outcome.followUps": ["{count} follow-ups", "{count} 个后续轮次", "{count} seguimientos"],
  "accounting.cacheContinuity.outcome.howToRead": ["How to read this: {percent} of checked follow-ups reused more than half of the previous turn's cache. Of those, {matched} reused at least as much cached context as before; {between} reused between half and the previous amount.", "读法：已检查的后续轮次中，有 {percent} 复用了上一个轮次一半以上的缓存。其中，{matched} 个复用的缓存上下文不少于之前，{between} 个复用了之前缓存量的一半到全部。", "Cómo leerlo: el {percent} de los seguimientos comprobados reutilizó más de la mitad de la caché del turno anterior. De ellos, {matched} reutilizaron al menos tanto contexto en caché como antes; {between} reutilizaron entre la mitad y la cantidad anterior."],
  "accounting.cacheContinuity.outcome.laneMore": ["REUSED MORE THAN HALF", "复用了超过一半", "REUTILIZÓ MÁS DE LA MITAD"],
  "accounting.cacheContinuity.outcome.laneLess": ["REUSED HALF OR LESS", "复用了一半或更少", "REUTILIZÓ LA MITAD O MENOS"],
  "accounting.cacheContinuity.outcome.lanePercent": ["{percent} of follow-ups", "占后续轮次的 {percent}", "{percent} de los seguimientos"],
  "accounting.cacheContinuity.outcome.axisLabel": ["Time since previous turn (log scale)", "距上一个轮次的时间（对数刻度）", "Tiempo desde el turno anterior (escala logarítmica)"],
  "accounting.cacheContinuity.outcome.canvasLabel": ["Cache reuse by time. Each hex represents {unit} checked follow-ups; a partly filled hex shows the remainder. {more} follow-ups reused more than half of the previous cache read and {less} reused half or less. Use the left and right arrow keys to inspect time ranges.", "按时间显示缓存复用。每个六边形代表 {unit} 个已检查的后续轮次；部分填充表示余数。{more} 个后续轮次复用了上一次缓存读取的一半以上，{less} 个复用了一半或更少。使用左右方向键查看各时间范围。", "Reutilización de caché por tiempo. Cada hexágono representa {unit} seguimientos comprobados; uno parcialmente lleno muestra el resto. {more} seguimientos reutilizaron más de la mitad de la lectura anterior y {less} reutilizaron la mitad o menos. Use las flechas izquierda y derecha para revisar los intervalos."],
  "accounting.cacheContinuity.outcome.readoutChecked": ["{count} follow-ups checked", "已检查 {count} 个后续轮次", "{count} seguimientos comprobados"],
  "accounting.cacheContinuity.outcome.readoutMore": ["{count} reused more than half · {percent}", "{count} 个复用了超过一半 · {percent}", "{count} reutilizaron más de la mitad · {percent}"],
  "accounting.cacheContinuity.outcome.readoutLess": ["{count} reused half or less · {percent}", "{count} 个复用了一半或更少 · {percent}", "{count} reutilizaron la mitad o menos · {percent}"],
  "accounting.cacheContinuity.outcome.readoutLost": ["Estimated lost reuse: {tokens} tokens", "估算的复用损失：{tokens} 个令牌", "Reutilización perdida estimada: {tokens} tokens"],
  "accounting.cacheContinuity.outcome.readoutApi": ["Standard API equivalent: {amount}", "Standard API 等价值：{amount}", "Equivalente de API Standard: {amount}"],
  "accounting.cacheContinuity.outcome.readoutSubtotal": ["Covered subtotal at Standard rates: {amount} · {priced} priced drops.", "按 Standard 费率计算的已覆盖小计：{amount} · {priced} 次已定价下降。", "Subtotal con cobertura y tarifas Standard: {amount} · {priced} caídas con precio."],
  "accounting.cacheContinuity.outcome.readoutSubtotalUnpriced": ["Covered subtotal at Standard rates: {amount} · {priced} priced drops. Excludes {unpriced} unpriced drops.", "按 Standard 费率计算的已覆盖小计：{amount} · {priced} 次已定价下降。排除了 {unpriced} 次未定价下降。", "Subtotal con cobertura y tarifas Standard: {amount} · {priced} caídas con precio. Excluye {unpriced} caídas sin precio."],
  "accounting.cacheContinuity.outcome.coverage.partial": ["Costs cover verified, priced comparisons only; this is not a complete period total.", "成本仅涵盖已验证且已定价的比较；这不是整个期间的总额。", "Los costes cubren solo comparaciones verificadas y con precio; no es un total completo del período."],
  "accounting.cacheContinuity.outcome.coverage.ordering": ["Excluded sessions with uncertain event order: {count}.", "因事件顺序不确定而排除的会话：{count} 个。", "Sesiones excluidas por un orden de eventos incierto: {count}."],
  "accounting.cacheContinuity.outcome.coverage.boundary": ["Excluded follow-ups without reliable boundary coverage: {count}.", "缺乏可靠边界覆盖而排除的后续轮次：{count} 个。", "Turnos posteriores excluidos por falta de cobertura fiable de límites: {count}."],
  "accounting.cacheContinuity.outcome.coverage.pricing": ["Excluded drops without supported prices: {count}.", "因缺乏受支持价格而排除的下降：{count} 次。", "Caídas excluidas por falta de precios compatibles: {count}."],
  "accounting.cacheContinuity.outcome.legendInline": ["= {count} follow-ups · partial = remainder", "= {count} 个后续轮次 · 部分填充 = 余数", "= {count} seguimientos · parcial = resto"],
  "accounting.cacheContinuity.outcome.realData": ["Using real local data", "使用真实本地数据", "Usando datos locales reales"],
  "accounting.cacheContinuity.outcome.noData": ["No eligible follow-up turns were found in this period.", "此期间未找到符合条件的后续轮次。", "No se encontraron turnos de seguimiento aptos en este período."],
  "accounting.cacheContinuity.outcome.bucket.underOneMinute": ["Under 1 minute", "少于 1 分钟", "Menos de 1 minuto"],
  "accounting.cacheContinuity.outcome.bucket.oneToTwoMinutes": ["1–2 minutes", "1–2 分钟", "1–2 minutos"],
  "accounting.cacheContinuity.outcome.bucket.twoToFiveMinutes": ["2–5 minutes", "2–5 分钟", "2–5 minutos"],
  "accounting.cacheContinuity.outcome.bucket.fiveToTenMinutes": ["5–10 minutes", "5–10 分钟", "5–10 minutos"],
  "accounting.cacheContinuity.outcome.bucket.tenToThirtyMinutes": ["10–30 minutes", "10–30 分钟", "10–30 minutos"],
  "accounting.cacheContinuity.outcome.bucket.thirtyMinutesToOneHour": ["30 minutes–1 hour", "30 分钟–1 小时", "30 minutos–1 hora"],
  "accounting.cacheContinuity.outcome.bucket.oneToSixHours": ["1–6 hours", "1–6 小时", "1–6 horas"],
  "accounting.cacheContinuity.outcome.bucket.sixToTwentyFourHours": ["6–24 hours", "6–24 小时", "6–24 horas"],
  "accounting.cacheContinuity.outcome.bucket.oneToThreeDays": ["1–3 days", "1–3 天", "1–3 días"],
  "accounting.cacheContinuity.outcome.bucket.overThreeDays": ["3 days or more", "3 天或更久", "3 días o más"],
  "accounting.cacheContinuity.detailsEmpty": ["No qualifying material cache-read drops in this period.", "此期间没有符合条件的缓存读取量大幅下降。", "No hay caídas materiales de lectura de caché que cumplan los requisitos en este período."],
  "accounting.cacheContinuity.recentHeading": ["Recent large cache drops", "近期缓存大幅下降", "Caídas grandes de caché recientes"],
  "accounting.cacheContinuity.tableCaption": ["Recent covered cache-continuity comparisons at Standard API rates; not a period total", "近期已覆盖的缓存连续性比较，按 Standard API 费率计算；并非期间总额", "Comparaciones recientes con cobertura de continuidad de caché, con tarifas de API Standard; no es un total del período"],
  "accounting.cacheContinuity.column.gap": ["Time between turns", "轮次间隔", "Tiempo entre turnos"],
  "accounting.cacheContinuity.column.configuration": ["Configuration", "配置", "Configuración"],
  "accounting.cacheContinuity.column.cacheRead": ["Cache read", "缓存读取", "Lectura de caché"],
  "accounting.cacheContinuity.column.apiEquivalent": ["API equivalent", "API 等值", "Equivalente de API"],
  "accounting.apiEquivalent.standardRateBasis": ["Calculated at Standard API rates.", "按 Standard API 费率计算。", "Calculado con tarifas Standard de API."],
  "accounting.apiEquivalent.explanation": ["A public API-price measuring stick for the usage observed locally. It is not a bill or a subscription limit.", "使用公开 API 价格衡量本地观测到的用量。它不是账单，也不是订阅额度上限。", "Una referencia de precios públicos de API para el uso observado localmente. No es una factura ni un límite de suscripción."],
  "accounting.apiEquivalent.standardRateDetail": ["{amount} at Standard rates before Fast weighting.", "应用 Fast 加权前按 Standard 费率计算的金额为 {amount}。", "{amount} con tarifas Standard antes de la ponderación Fast."],
  "accounting.apiEquivalent.noWeightedUsage": ["No increment in this period could be weighted", "此期间没有可加权的用量增量", "No se pudo ponderar ningún incremento de este período"],
  "accounting.cacheContinuity.premiumUnavailable": ["Unavailable", "不可用", "No disponible"],
  "accounting.cacheContinuity.configuration": ["{model} · {effort}", "{model} · {effort}", "{model} · {effort}"],
  "accounting.cacheContinuity.gapMinutes": ["{value} min", "{value} 分钟", "{value} min"],
  "accounting.cacheContinuity.gapHours": ["{value} hr", "{value} 小时", "{value} h"],
  "accounting.cacheContinuity.gapDays": ["{value} days", "{value} 天", "{value} días"],
  "accounting.sideChat.metricLabel": ["Estimated side-chat usage", "估算的侧聊使用量", "Uso estimado de chats laterales"],
  "accounting.sideChat.metricExplanation": ["A development-only Standard API-price scenario for deduplicated side-chat sampling markers. Only active-context volume is observed; token components and cache behavior are reconstructed. The estimate never changes exact totals. Surviving calls from the approximately 10-day active logs_2 window do enter the experimental speed-priced red line, calibration metrics, and AUC when parser, pricing, and cohort checks pass; expired history remains unknown.", "仅用于开发的 Standard API 价格情景，基于已去重的侧聊采样标记。仅活动上下文量是观测值；令牌组成和缓存行为均为重建。该估算绝不更改精确总额。约 10 天的当前 logs_2 窗口中仍保留的调用在解析、定价和队列检查通过后，会进入实验性的按速度档定价红线、校准指标和 AUC；已过期历史仍为未知。", "Escenario de precios de API Standard solo para desarrollo basado en marcadores deduplicados. Solo se observa el volumen de contexto activo; los componentes de tokens y el comportamiento de caché se reconstruyen. La estimación nunca cambia los totales exactos. Las llamadas que sobreviven en la ventana activa de logs_2 de unos 10 días entran en la línea roja experimental con precio según velocidad, las métricas de calibración y el AUC cuando superan las comprobaciones; el historial caducado sigue siendo desconocido."],
  "accounting.sideChat.noteRetainedSubset": ["The selected period begins before active numeric side-chat retention. {estimate} is the surviving estimate from {start} onward, not an estimate for the selected period; missing history is unknown, not zero.", "所选期间早于当前侧聊数值证据的保留起点。{estimate} 仅是自 {start} 起仍保留的估算，并非所选期间的估算；缺失历史是未知，而不是零。", "El período seleccionado comienza antes de la retención numérica activa de chats laterales. {estimate} es la estimación que sobrevive desde {start}, no una estimación del período seleccionado; el historial ausente es desconocido, no cero."],
  "accounting.sideChat.retainedHeading": ["Retained numeric estimate", "保留的数值估算", "Estimación numérica conservada"],
  "accounting.sideChat.historicalGap.kicker": ["Historical test case", "历史测试案例", "Caso de prueba histórico"],
  "accounting.sideChat.historicalGap.heading": ["Historical quota-gap backcast", "历史额度缺口回推", "Retrocálculo histórico de la brecha de cuota"],
  "accounting.sideChat.historicalGap.focus": ["View this day on the timeline", "在时间线中查看这一天", "Ver este día en la cronología"],
  "accounting.sideChat.historicalGap.explanation": ["For {date}, the unified index preserves {events} exact logged calls across {sessions} sessions. It does not preserve expired side-chat turns. The final scenario asks how much additional {model} Fast activity at {multiplier}× would be required to explain the residual.", "对于 {date}，统一索引保留了 {sessions} 个会话中的 {events} 次精确日志调用，但不会保留已过期的侧聊轮次。最终情景询问：还需要多少按 {multiplier}× 计权的 {model} Fast 活动才能解释残差。", "Para {date}, el índice unificado conserva {events} llamadas exactas registradas en {sessions} sesiones, pero no los turnos caducados de chats laterales. El escenario final pregunta cuánta actividad Fast adicional de {model}, ponderada a {multiplier}×, haría falta para explicar el residuo."],
  "accounting.sideChat.historicalGap.metric.quota": ["Observed quota movement", "观测到的额度变化", "Movimiento de cuota observado"],
  "accounting.sideChat.historicalGap.metric.exact": ["Exact logged usage", "精确日志使用量", "Uso exacto registrado"],
  "accounting.sideChat.historicalGap.metric.weighted": ["Exact usage after speed weighting", "速度权重后的精确使用量", "Uso exacto tras ponderar la velocidad"],
  "accounting.sideChat.historicalGap.metric.expected": ["Cost-implied movement", "成本推算的变化", "Movimiento implícito por el coste"],
  "accounting.sideChat.historicalGap.metric.unexplained": ["Movement still unexplained", "仍未解释的变化", "Movimiento aún sin explicar"],
  "accounting.sideChat.historicalGap.metric.backcast": ["Missing Fast usage required to close the daily gap", "填补每日缺口所需的 Fast 使用量", "Uso Fast faltante necesario para cerrar la brecha diaria"],
  "accounting.sideChat.historicalGap.metric.peak": ["Largest 3-hour speed-priced gap", "最大的 3 小时按速度档定价缺口", "Mayor brecha con precio según velocidad de 3 horas"],
  "accounting.sideChat.historicalGap.percentagePoints": ["{value} pp", "{value} 个百分点", "{value} pp"],
  "accounting.sideChat.historicalGap.percentagePointRange": ["{lower}–{upper} pp", "{lower}–{upper} 个百分点", "{lower}–{upper} pp"],
  "accounting.sideChat.historicalGap.exactValue": ["{cost} · {events} calls", "{cost} · {events} 次调用", "{cost} · {events} llamadas"],
  "accounting.sideChat.historicalGap.moneyRange": ["{lower}–{upper}", "{lower}–{upper}", "{lower}–{upper}"],
  "accounting.sideChat.historicalGap.backcastValue": ["{standard} Standard API equivalent · {weighted} speed-priced", "{standard} Standard API 等价值 · {weighted} 按速度档定价", "{standard} equivalente de API Standard · {weighted} con precio según velocidad"],
  "accounting.sideChat.historicalGap.backcastRange": ["{standard} Standard API-equivalent range · {weighted} speed-priced range", "{standard} Standard API 等价范围 · {weighted} 按速度档定价范围", "{standard} rango equivalente de API Standard · {weighted} rango con precio según velocidad"],
  "accounting.sideChat.historicalGap.peakValue": ["{residual} pp gap ({observed} observed − {expected} speed-priced)", "缺口 {residual} 个百分点（观测 {observed} − 按速度档定价推算 {expected}）", "Brecha de {residual} pp ({observed} observado − {expected} con precio según velocidad)"],
  "accounting.sideChat.historicalGap.note": ["Speed evidence: {fast} Fast, {standard} Standard, and {unknown} source-unknown. Source-unknown calls are attributed to Standard at 1x by default. The retained weekly fit uses {resets} resets and paired scenario medians of {capacity} that may combine accounts. Each numerator is divided only by its matching speed scenario. Missing calls are hypothetical and their context was not observed, so their backcast conversion explicitly assumes 2x Standard, not a published Priority rate. The broader backcast sensitivity is {standardSensitivity} in Standard API-equivalent units and {weightedSensitivity} after quota weighting. No July 13 side-chat calls were recovered from retained numeric diagnostics. This value is fitted to observed quota movement, not independently observed, and remains excluded from exact totals, the expected line, and AUC. The 3-hour chart now uses speed-priced cost per bucket.", "速度证据：{fast} 次 Fast、{standard} 次 Standard、{unknown} 次来源未知。来源未知的调用默认按 Standard 的 1× 归因。保留的每周拟合使用 {resets} 次重置，以及可能合并多个账户的 {capacity} 配对情景中位数。每个分子只除以其匹配的速度情景。缺失调用是假设的，其上下文未经观测，因此回推换算明确假定为 Standard 的 2×，而非已公布的 Priority 价格。更广的回推敏感性范围为 Standard API 等价单位的 {standardSensitivity}，按速度档定价后为 {weightedSensitivity}。保留的数值诊断没有恢复任何 7 月 13 日的侧聊调用。该数值是根据观测额度变化拟合的，并非独立观测；仍不计入精确总额、预期线或 AUC。3 小时图表现在使用每个分桶的按速度档定价成本。", "Evidencia de velocidad: {fast} Fast, {standard} Standard y {unknown} con origen desconocido. Las llamadas de origen desconocido se atribuyen a Standard a 1× por defecto. El ajuste semanal conservado usa {resets} restablecimientos y medianas emparejadas por escenario de {capacity}, que pueden combinar cuentas. Cada numerador se divide solo por su escenario de velocidad correspondiente. Las llamadas ausentes son hipotéticas y su contexto no se observó, por lo que su conversión retrospectiva asume explícitamente 2× Standard, no un precio Priority publicado. La sensibilidad más amplia del retrocálculo es {standardSensitivity} en unidades equivalentes de API Standard y {weightedSensitivity} tras ponderar por cuota. No se recuperó ninguna llamada de chat lateral del 13 de julio en los diagnósticos numéricos conservados. Este valor se ajusta al movimiento de cuota observado, no se observa independientemente, y sigue excluido de los totales exactos, la línea esperada y el AUC. El gráfico de 3 horas ahora usa coste con precio según velocidad en cada intervalo."],
  "accounting.sideChat.noteUnavailable": ["The development estimator is not enabled.", "开发估算器未启用。", "El estimador de desarrollo no está activado."],
  "accounting.sideChat.noteObserved": ["{calls} deduplicated retained sampling markers in {retained} side chats · {detected} side-chat lifecycles began in this period.", "{retained} 个侧聊中保留了 {calls} 个已去重采样标记 · 此期间开始了 {detected} 个侧聊生命周期。", "{calls} marcadores de muestreo conservados y deduplicados en {retained} chats laterales · {detected} ciclos comenzaron en este período."],
  "accounting.sideChat.noteRange": ["Sensitivity range {lower}–{upper}.", "敏感性范围 {lower}–{upper}。", "Intervalo de sensibilidad {lower}–{upper}."],
  "accounting.sideChat.detailsSummary": ["See experimental side-chat estimate", "查看实验性侧聊估算", "Ver la estimación experimental de chats laterales"],
  "accounting.sideChat.detailsExplanation": ["This development-only estimate finds confirmed desktop side-chat lifecycles and prices deduplicated sampling markers that still survive in numeric local diagnostics. The active window is approximately 10 days; expired or rotated partitions are unknown and are not reconstructed. Active-context volume is observed, while input, cache, output, and reasoning components are reconstructed. Ordinary calls use the owner-directed mostly-warm point; an observed compaction makes the next point cold. Auto Review and other reviewed aliases retain their conditional alias-rate assumption. Exact totals remain unchanged. Surviving eligible estimates are speed-weighted and added only to the experimental red line, calibration metrics, and AUC, with the exact-ledger baseline kept beside them.", "此仅用于开发的估算会查找已确认的桌面侧聊生命周期，并为本地数值诊断中仍保留的已去重采样标记计价。当前窗口约为 10 天；已过期或轮换的分区为未知，且不会重建。活动上下文量是观测值，而输入、缓存、输出和推理组成均为重建。普通调用使用用户指定的主要为热缓存点估算；观测到压缩后，下一个点按冷缓存处理。Auto Review 和其他已审核别名保留条件性别名费率假设。精确总额保持不变。仍保留且符合条件的估算会按速度加权，只加入实验性红线、校准指标和 AUC，并保留精确账本基线作对照。", "Esta estimación solo para desarrollo detecta ciclos confirmados de chats laterales y valora marcadores deduplicados que aún sobreviven en los diagnósticos numéricos locales. La ventana activa es de unos 10 días; las particiones caducadas o rotadas son desconocidas y no se reconstruyen. Se observa el volumen de contexto activo, mientras que los componentes de entrada, caché, salida y razonamiento se reconstruyen. Las llamadas ordinarias usan el punto mayormente caliente indicado; una compactación observada hace frío el punto siguiente. Auto Review y otros alias revisados conservan su supuesto condicional. Los totales exactos no cambian. Las estimaciones elegibles se ponderan por velocidad y se añaden solo a la línea roja experimental, las métricas de calibración y el AUC, manteniendo al lado la base del registro exacto."],
  "accounting.sideChat.recentHeading": ["Retained sampling calls", "保留的采样调用", "Llamadas de muestreo conservadas"],
  "accounting.sideChat.tableCaption": ["Experimental side-chat sampling-call estimates", "实验性侧聊采样调用估算", "Estimaciones experimentales de llamadas de chats laterales"],
  "accounting.sideChat.column.localTime": ["Local time", "本地时间", "Hora local"],
  "accounting.sideChat.column.turn": ["Turn", "轮次", "Turno"],
  "accounting.sideChat.column.configuration": ["Configuration", "配置", "Configuración"],
  "accounting.sideChat.column.activeContext": ["Active context", "活动上下文", "Contexto activo"],
  "accounting.sideChat.column.cacheAssumption": ["Cache assumption", "缓存假设", "Supuesto de caché"],
  "accounting.sideChat.column.apiEstimate": ["Estimated Standard API equivalent", "估算的 Standard API 等价值", "Equivalente de API Standard estimado"],
  "accounting.sideChat.summary.detected": ["Lifecycles begun", "开始的生命周期", "Ciclos iniciados"],
  "accounting.sideChat.summary.visibleTurns": ["Visible turns", "可见轮次", "Turnos visibles"],
  "accounting.sideChat.summary.samplingCalls": ["Sampling calls", "采样调用", "Llamadas de muestreo"],
  "accounting.sideChat.summary.activeContext": ["Active-context tokens", "活动上下文令牌", "Tokens de contexto activo"],
  "accounting.sideChat.coveragePartial": ["Numeric diagnostics survive for {retained} of {detected} detected side chats; {missing} expired before their numeric evidence could be recovered. Missing is unknown, not zero.", "{detected} 个已检测侧聊中有 {retained} 个仍保留数值诊断；另有 {missing} 个在恢复数值证据前已过期。缺失表示未知，而不是零。", "Los diagnósticos numéricos sobreviven para {retained} de {detected} chats laterales detectados; {missing} caducaron antes de poder recuperar su evidencia numérica. Ausente significa desconocido, no cero."],
  "accounting.sideChat.coverageComplete": ["Numeric diagnostics survive for all {detected} detected side chats in the retained desktop-log span.", "在保留的桌面日志时间范围内，所有 {detected} 个已检测侧聊都保留了数值诊断。", "Los diagnósticos numéricos sobreviven para los {detected} chats laterales detectados en el intervalo conservado de registros del escritorio."],
  "accounting.sideChat.coverageParserGaps": ["Parser gaps: {sampling} sampling markers, {compactions} compaction markers, {duplicates} ambiguous duplicate markers, and {lines} oversized desktop-log lines could not be classified safely.", "解析器缺口：有 {sampling} 个采样标记、{compactions} 个压缩标记、{duplicates} 个歧义重复标记和 {lines} 行超大桌面日志无法安全分类。", "Brechas del analizador: no se pudieron clasificar de forma segura {sampling} marcadores de muestreo, {compactions} de compactación, {duplicates} duplicados ambiguos y {lines} líneas sobredimensionadas."],
  "accounting.sideChat.coverageActiveRetention": ["Numeric coverage is limited to the active logs_2.sqlite window of approximately 10 days; rotated or expired partitions are unknown and are not reconstructed.", "数值覆盖仅限约 10 天的当前 logs_2.sqlite 窗口；轮换或已过期的分区为未知，且不会被重建。", "La cobertura numérica se limita a la ventana activa de logs_2.sqlite de unos 10 días; las particiones rotadas o caducadas son desconocidas y no se reconstruyen."],
  "accounting.sideChat.coverageKnownFormats": ["Detection recognizes only the current known desktop lifecycle and numeric diagnostic formats; a logging-format change or a lifecycle split across rotated files can create an unmeasured gap.", "检测仅识别当前已知的桌面生命周期和数值诊断格式；日志格式变化或生命周期跨轮换文件拆分都可能造成无法测量的缺口。", "La detección solo reconoce los formatos actuales conocidos del ciclo de vida de escritorio y de los diagnósticos numéricos; un cambio de formato o un ciclo dividido entre archivos rotados puede crear una brecha no medida."],
  "accounting.sideChat.pricingCoverage": ["{priced} of {calls} retained calls have a complete reviewed scenario price; {unpriced} are unavailable.", "{calls} 个保留调用中有 {priced} 个具有完整的审核情景价格；{unpriced} 个不可用。", "{priced} de {calls} llamadas conservadas tienen un precio de escenario revisado completo; {unpriced} no están disponibles."],
  "accounting.sideChat.detailsEmpty": ["No retained sampling calls fall in this period.", "此期间没有保留的采样调用。", "No hay llamadas de muestreo conservadas en este período."],
  "accounting.sideChat.configuration": ["{model} · {effort}", "{model} · {effort}", "{model} · {effort}"],
  "accounting.sideChat.configurationAliasAssumption": ["{configuration} · conditional alias-rate assumption", "{configuration} · 条件性别名费率假设", "{configuration} · supuesto condicional de tarifa del alias"],
  "accounting.sideChat.turnOrdinal": ["Turn {ordinal}", "第 {ordinal} 轮", "Turno {ordinal}"],
  "accounting.sideChat.cache.warmPrefix": ["Owner-directed mostly-warm point · full-cold sensitivity · cache unobserved", "用户指定的主要为热缓存点估算 · 完全冷缓存敏感性 · 未观测缓存状态", "Punto mayormente caliente indicado · sensibilidad totalmente fría · caché no observada"],
  "accounting.sideChat.cache.coldAfterCompaction": ["Cold point after compaction · full-cold sensitivity · cache unobserved", "压缩后的冷缓存点估算 · 完全冷缓存敏感性 · 未观测缓存状态", "Punto frío tras compactación · sensibilidad totalmente fría · caché no observada"],
  "accounting.sideChat.cache.retentionUnknown": ["Mostly-warm point · full-cold sensitivity after elapsed proxy · cache unobserved", "较长代理间隔后的主要为热缓存点估算 · 完全冷缓存敏感性 · 未观测缓存状态", "Punto mayormente caliente · sensibilidad totalmente fría tras el proxy temporal · caché no observada"],
  "accounting.sideChat.calibration.eligibleActiveRetention": ["Eligible estimates surviving in the approximately 10-day active window are included in the development-only speed-priced red line, calibration metrics, and AUC; expired history remains unknown.", "约 10 天当前窗口中仍保留且符合条件的估算会计入仅用于开发的按速度档定价红线、校准指标和 AUC；已过期历史仍为未知。", "Las estimaciones elegibles que sobreviven en la ventana activa de unos 10 días se incluyen en la línea roja con precio según velocidad, las métricas de calibración y el AUC solo para desarrollo; el historial caducado sigue siendo desconocido."],
  "accounting.sideChat.calibration.withheldNoCalls": ["The calibration overlay is withheld because no retained sampling markers are available.", "由于没有保留的采样标记，校准叠加已被禁用。", "La superposición de calibración se retiene porque no hay marcadores conservados."],
  "accounting.sideChat.calibration.withheldUnpriced": ["The calibration overlay is withheld because at least one reconstructed scenario has no reviewed price card.", "由于至少一个重建情景没有经过审核的价格卡，校准叠加已被禁用。", "La superposición se retiene porque al menos un escenario reconstruido carece de precio revisado."],
  "accounting.sideChat.calibration.withheldParserGaps": ["The calibration overlay is withheld because parser coverage is incomplete.", "由于解析器覆盖不完整，校准叠加已被禁用。", "La superposición se retiene porque la cobertura del analizador es incompleta."],
  "accounting.sideChat.calibration.withheldPartialRetention": ["The calibration overlay is withheld because some side-chat evidence expired or reached its retention limit; the displayed estimate covers only what survives.", "由于部分侧聊证据已过期或达到保留上限，校准叠加已被禁用；显示的估算仅覆盖仍保留的证据。", "La superposición se retiene porque parte de la evidencia caducó o alcanzó su límite; la estimación mostrada solo cubre lo que sobrevive."],
  "accounting.sideChat.calibration.withheldCohortMismatch": ["The calibration overlay is withheld because retained calls fall outside the frozen GPT-5.6 Sol high/max cohort.", "由于保留调用超出冻结的 GPT-5.6 Sol high/max 校准队列，校准叠加已被禁用。", "La superposición se retiene porque las llamadas quedan fuera de la cohorte congelada GPT-5.6 Sol high/max."],
  "accounting.sideChat.calibration.withheldContextMismatch": ["The calibration overlay is withheld because at least one retained call falls outside the frozen short-context cohort.", "由于至少一个保留调用超出冻结的短上下文校准队列，校准叠加已被禁用。", "La superposición se retiene porque al menos una llamada queda fuera de la cohorte congelada de contexto corto."],
  "accounting.sideChat.calibration.withheldStaleCalibration": ["The calibration overlay is withheld because the frozen comparison cohort is more than 30 days old.", "由于冻结的比较队列已超过 30 天，校准叠加已被禁用。", "La superposición se retiene porque la cohorte de comparación congelada tiene más de 30 días."],
  "accounting.sideChat.calibration.withheldUnavailable": ["The calibration overlay is unavailable.", "校准叠加不可用。", "La superposición de calibración no está disponible."],
  "accounting.sideChat.estimateRange": ["{point} ({lower}–{upper})", "{point}（{lower}–{upper}）", "{point} ({lower}–{upper})"],
  "accounting.model.noneInPeriod": ["No model usage in this period.", "此期间没有模型使用记录。", "No hay uso de modelos en este período."],
  "accounting.model.unavailable": ["Model usage accounting is unavailable; no zero usage is inferred.", "模型使用情况核算不可用；不会推断为零使用量。", "La contabilidad de uso por modelo no está disponible; no se infiere un uso cero."],
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
  // Component rows under a model. Every share in this table is against the
  // whole period, so components add up to their model and models add up to the
  // total; the denominator is stated once in the caption rather than on each
  // row, where it would be text to read past on every comparison.
  "accounting.model.componentCached": ["Cached input", "缓存输入", "Entrada en caché"],
  "accounting.model.componentUncached": ["Uncached input", "未缓存输入", "Entrada sin caché"],
  "accounting.model.componentCacheWrite": ["Cache write", "缓存写入", "Escritura en caché"],
  "accounting.model.componentOutputText": ["Output text", "输出文本", "Texto de salida"],
  "accounting.model.componentReasoning": ["Reasoning output", "推理输出", "Salida de razonamiento"],
  "accounting.model.componentCombined": ["Combined output", "合并输出", "Salida combinada"],
  "accounting.model.expand": ["Show the token components of {model}", "显示 {model} 的令牌组成", "Mostrar los componentes de tokens de {model}"],
  "accounting.model.collapse": ["Hide the token components of {model}", "隐藏 {model} 的令牌组成", "Ocultar los componentes de tokens de {model}"],
  // A usage change carries every component at once, so the count does not
  // divide between them. Withheld rather than shown as zero.
  "accounting.model.componentEventsWithheld": ["—", "—", "—"],
  "accounting.model.componentEventsWithheldTitle": ["A usage change carries every token component at once, so it cannot be divided between them.", "一次使用变更同时包含所有令牌组成部分，因此无法在它们之间划分。", "Un cambio de uso incluye todos los componentes de tokens a la vez, por lo que no puede dividirse entre ellos."],
  "accounting.model.componentsUnavailable": ["This row reported no token components, so none are shown rather than shown as zero.", "此行未报告令牌组成，因此不显示，而不是显示为零。", "Esta fila no informó componentes de tokens, por lo que no se muestran en lugar de mostrarse como cero."],
  "accounting.model.componentCostWithheld": ["—", "—", "—"],
  "accounting.model.componentCostWithheldTitle": ["No priced amount was reported for this component, so none is shown rather than shown as a priced zero.", "此组成部分没有报告计价金额，因此不显示，而不是显示为计价零。", "No se informó ningún importe con precio para este componente, así que no se muestra en lugar de mostrarse como un cero con precio."],
  "accounting.model.componentFootnote": ["A component row shows no usage-change count, because one usage change carries every component at once and cannot be divided between them. Where a model states no API equivalent, its components state none either.", "组成部分行不显示使用变更计数，因为一次使用变更同时包含所有组成部分，无法在它们之间划分。若某个模型没有 API 等价值，其组成部分也不会显示。", "Una fila de componente no muestra recuento de cambios de uso, porque un cambio de uso incluye todos los componentes a la vez y no puede dividirse entre ellos. Cuando un modelo no indica equivalente de API, sus componentes tampoco lo indican."],
  "accounting.model.shareHeading": ["Share", "占比", "Proporción"],
  "accounting.model.shareOfPeriod": ["Both share columns are a share of the whole period, so components add up to their model and models add up to the total.", "两个占比列均相对于整个期间，因此各组成部分之和等于其模型，各模型之和等于总计。", "Ambas columnas de proporción son respecto al período completo, por lo que los componentes suman su modelo y los modelos suman el total."],
  "accounting.model.shareWithheld": ["—", "—", "—"],
  "accounting.period.indexedHistory": ["Indexed history", "已索引历史", "Historial indexado"],
  "accounting.period.indexedHistorySoFar": ["Indexed history so far", "目前已索引的历史", "Historial indexado hasta ahora"],
  "accounting.fastMode.noUsage": ["No usage increments in this period, so there is no speed-mode attribution to report.", "此期间没有使用增量，因此没有可报告的速度模式归因。", "No hay incrementos de uso en este período, por lo que no hay atribución de modo de velocidad que informar."],
  "accounting.fastMode.observed": ["{count} observed in the logs", "日志中观测到 {count} 个", "{count} observados en los registros"],
  "accounting.fastMode.declaredFromConfig": ["{count} declared by timestamped Codex config", "带时间戳的 Codex 配置声明 {count} 个", "{count} declarados por la configuración de Codex con fecha y hora"],
  "accounting.fastMode.stated": ["{count} assumed Standard by default", "默认按 Standard 假定 {count} 个", "{count} asumidos como Standard por defecto"],
  "accounting.fastMode.assumedRatio": ["Includes {amount} of Standard-rate cost weighted at an assumed 2x because no published Priority rate matches the model, date or context.", "其中 {amount} 的 Standard 费率成本因没有匹配模型、日期或上下文的已公布 Priority 价格而按假定的 2 倍加权。", "Incluye {amount} de coste a tarifa Standard ponderado por un 2x asumido porque no hay un precio Priority publicado que coincida con el modelo, la fecha o el contexto."],
  "accounting.fastMode.inferred": ["{count} inferred from calibration residuals", "根据校准残差推断 {count} 个", "{count} inferidos a partir de residuos de calibración"],
  "accounting.fastMode.unknown": ["{count} still unknown", "仍有 {count} 个未知", "{count} aún desconocidos"],
  "accounting.fastMode.unknownShare": [" ({percent} of increments).", "（占增量的 {percent}）。", " ({percent} de los incrementos)."],
  "accounting.fastMode.unweighted": [" {amount} of Standard-rate cost could not be weighted and is excluded from the weighted total rather than counted at 1x.", " 有 {amount} 的标准费率成本无法加权，因此从加权总额中排除，而不是按 1 倍计入。", " {amount} de coste a tarifa Standard no pudo ponderarse y se excluye del total ponderado en lugar de contarse a 1×."],
  "accounting.fastMode.coverage": ["Of {total} usage increments: {parts}{share}{unweighted} Codex records the mode only when it is applied or changed, so turns before the first change in a session are never observed and a small structural error in the calibration cannot be engineered away.", "在 {total} 个使用增量中：{parts}{share}{unweighted} Codex 只会在模式被应用或更改时记录该模式，因此会话中首次更改前的轮次永远不会被观测到，校准中的小型结构性误差也无法人为消除。", "De {total} incrementos de uso: {parts}{share}{unweighted} Codex registra el modo solo cuando se aplica o cambia, por lo que los turnos anteriores al primer cambio de una sesión nunca se observan y no se puede eliminar mediante ingeniería un pequeño error estructural de la calibración."],
  "accounting.fastMode.inferenceNotRun": ["Residual inference has not run: there is not yet enough matched calibration evidence to compare a window against a Standard reference.", "残差推断尚未运行：还没有足够的匹配校准证据将某个窗口与 Standard 参考进行比较。", "La inferencia de residuos no se ha ejecutado: todavía no hay suficiente evidencia de calibración coincidente para comparar una ventana con una referencia Standard."],
  "accounting.fastMode.inferenceNone": ["Residual inference compared {scored} calibration windows against {reference} Standard references and marked none as Fast.", "残差推断将 {scored} 个校准窗口与 {reference} 个 Standard 参考进行了比较，没有标记任何一个为 Fast。", "La inferencia de residuos comparó {scored} ventanas de calibración con {reference} referencias Standard y no marcó ninguna como Fast."],
  "accounting.fastMode.inferenceSome": ["Residual inference marked {fast} of {scored} calibration windows as inferred Fast, against {reference} Standard references. Inference labels windows, never individual increments, so it is reported here and never folded into the weighted total.", "残差推断在与 {reference} 个 Standard 参考比较后，将 {scored} 个校准窗口中的 {fast} 个标记为推断的 Fast。推断标记的是窗口而非单个增量，因此只在此报告，绝不会并入加权总额。", "La inferencia de residuos marcó {fast} de {scored} ventanas de calibración como Fast inferido, frente a {reference} referencias Standard. La inferencia etiqueta ventanas, nunca incrementos individuales, por lo que se informa aquí y nunca se incorpora al total ponderado."],
  // The stat tiles carry bare figures; their per-point unit lives in the
  // static labels beneath them, so the old sentence-length "perPoint" and
  // "range" values left with the table presentation (owner-directed,
  // 2026-08-10). The example translation is a full sentence rendered as prose
  // under the stat row.
  "dashboard.calibration.rangeUnavailable": ["Range unavailable", "区间不可用", "Intervalo no disponible"],
  // Composition-aware per-model detail behind the blended headline (owner
  // decision 2026-08-10: blended "$X per point" leads; per-model on expand).
  "dashboard.calibration.perModelSummary": ["Per-model rates", "各模型费率", "Tasas por modelo"],
  "dashboard.calibration.perModelExplainer": ["Each model consumes the weekly allowance at its own rate, so the headline blends these over your recent mix.", "每个模型以各自的速率消耗每周额度，因此标题按你近期的模型组合对这些费率加权混合。", "Cada modelo consume la asignación semanal a su propia tasa, así que el titular las combina según tu mezcla reciente."],
  "dashboard.calibration.perModelRate": ["{amount} per point", "每点 {amount}", "{amount} por punto"],
  // A model too small for its own fitted column still consumed the allowance,
  // and dropping it from this list made the card read as if it had not been
  // seen at all. It is named here against the rate the fit actually charges
  // it: the pooled remainder column, or nothing when that column is empty too.
  "dashboard.calibration.perModelShared": ["Shared rate · {share} of the fitted mix", "共享费率 · 占拟合组合的 {share}", "Tasa compartida · {share} de la mezcla ajustada"],
  "dashboard.calibration.perModelNoRate": ["No fitted rate · {share} of the fitted mix", "无拟合费率 · 占拟合组合的 {share}", "Sin tasa ajustada · {share} de la mezcla ajustada"],
  "dashboard.calibration.perModelRateUnavailable": ["Not separately estimable", "无法单独估算", "No estimable por separado"],
  "dashboard.calibration.perModelSharedExplainer": ["A model holding less than {threshold} of the fitted mix is too small to carry a rate of its own, so its usage is priced at one rate fitted for the remainder.", "占拟合组合不足 {threshold} 的模型太小，无法单独承载自己的费率，因此其使用量按为其余部分拟合的统一费率计价。", "Un modelo con menos del {threshold} de la mezcla ajustada es demasiado pequeño para tener una tasa propia, así que su uso se valora con una única tasa ajustada para el resto."],
  "dashboard.calibration.example": ["$100 of speed-priced API-equivalent usage corresponds to about {points} percentage points.", "按速度档定价 API 等价值使用量每 100 美元约对应 {points} 个百分点。", "100 USD de uso equivalente de API con precio según velocidad corresponden a unos {points} puntos porcentuales."],
  "dashboard.calibration.noRate": [`The weekly calibration contract requires at least ${WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES} unique quota-boundary observations spanning at least ${WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP} displayed percentage points, plus a valid positive fit, before TiboTattle can estimate this rate and range. API prices remain a measuring stick, not a subscription charge.`, `每周校准契约要求至少 ${WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES} 个唯一额度边界观测值，跨度至少为 ${WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP} 个显示百分点，并且拟合必须有效且为正，TiboTattle 才能估算此费率和区间。API 价格仍只是衡量尺，而不是订阅费用。`, `El contrato de calibración semanal exige al menos ${WEEKLY_CALIBRATION_MINIMUM_QUOTA_BOUNDARIES} observaciones únicas de límites de cuota que abarquen al menos ${WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP} puntos porcentuales mostrados, además de un ajuste positivo válido, antes de que TiboTattle pueda estimar esta tasa y su intervalo. Los precios de API siguen siendo una referencia, no un cargo de suscripción.`],
  "dashboard.calibration.withRange": ["Across {count} qualifying resets, the fitted seven-day allowance is {amount}; the middle 80% of those estimates spans {lower}–{upper}. Observed movement comes from the provider. Cost-implied movement translates local activity using the price in effect when each event occurred.", "在 {count} 次合格重置中，拟合的七天额度为 {amount}；这些估计的中间 80% 范围为 {lower}–{upper}。观测变化来自提供商。成本推算变化使用每个事件发生时有效的价格换算本地活动。", "En {count} reinicios válidos, el límite ajustado de siete días es {amount}; el 80 % central de esas estimaciones abarca {lower}–{upper}. El movimiento observado procede del proveedor. El movimiento implícito por coste traduce la actividad local con el precio vigente cuando ocurrió cada evento."],
  "dashboard.calibration.withoutRange": ["The central fit implies a full 100-point allowance near {amount} speed-priced API equivalent, but there is not yet a usable across-reset range. This is not a provider-published dollar cap.", "中心拟合表明完整的 100 点额度约为 {amount} 的按速度档定价 API 等价值，但尚无可用的跨重置区间。这不是提供商公布的美元上限。", "El ajuste central implica una asignación completa de 100 puntos cercana a {amount} de equivalente de API con precio según velocidad, pero todavía no hay un intervalo utilizable entre restablecimientos. No es un límite monetario publicado por el proveedor."],
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
  "dashboard.timeline.liveCopy": ["Quota movement is compared with speed-priced local usage, applying published Fast (Priority) price ratios; times are shown in {timeZone}.", "额度变化与按速度档定价的本地使用量进行比较，并应用已公布的 Fast（Priority）价格倍率；时间显示为 {timeZone}。", "El movimiento de cuota se compara con el uso local con precio según velocidad, aplicando los multiplicadores de precio Fast (Priority) publicados; las horas se muestran en {timeZone}."],
  "dashboard.timeline.liveCopySideChatAdjusted": ["Quota movement is compared with speed-priced exact usage plus eligible side-chat estimates surviving in the approximately 10-day active window; expired side-chat history is unknown. Times are shown in {timeZone}.", "额度变化与按速度档定价的精确使用量加上约 10 天当前窗口中仍保留且符合条件的侧聊估算进行比较；已过期侧聊历史为未知。时间显示为 {timeZone}。", "El movimiento de cuota se compara con el uso exacto con precio según velocidad más las estimaciones elegibles de chats laterales que sobreviven en la ventana activa de unos 10 días; el historial caducado es desconocido. Las horas se muestran en {timeZone}."],
  "dashboard.timeline.liveCopyHistoricalGapCapacity": ["Speed-priced local usage and retained quota movement are shown in {timeZone}. The development probe supplies an account-unattributed weekly median; published Fast (Priority) price ratios are applied to every eligible bucket.", "按速度档定价的本地使用量和保留的额度变化显示为 {timeZone}。开发探针提供账户未归属的每周中位数；每个符合条件的分桶均应用已公布的 Fast（Priority）价格倍率。", "El uso local con precio según velocidad y el movimiento de cuota conservado se muestran en {timeZone}. La sonda aporta una mediana semanal sin atribución de cuenta; se aplican multiplicadores de precio Fast (Priority) publicados a cada intervalo elegible."],
  "dashboard.timeline.historicalCopy": ["Historical local calibration artifact from {generatedAt} · recent quota snapshots are too sparse to bracket {window} endpoints", "来自 {generatedAt} 的历史本地校准产物 · 最近的额度快照过于稀疏，无法界定 {window} 的端点", "Artefacto histórico de calibración local de {generatedAt} · las instantáneas recientes de cuota son demasiado escasas para acotar los extremos de {window}"],
  "dashboard.timeline.notComparableYet": ["Not comparable yet", "尚不可比较", "Aún no comparable"],
  "dashboard.timeline.noBracket": ["Cost history exists, but quota observations do not bracket any {window} window in this date range. The calculated line is hidden until there is measured evidence to compare it with.", "存在成本历史记录，但额度观测无法在此日期范围内界定任何 {window} 窗口。在有可供比较的测量证据前，计算线会保持隐藏。", "Existe historial de costes, pero las observaciones de cuota no delimitan ninguna ventana de {window} en este intervalo de fechas. La línea calculada permanece oculta hasta que haya evidencia medida con la que compararla."],
  "dashboard.timeline.missingData": ["This is a missing-data state, not a zero-usage period.", "这是缺失数据状态，不是零使用期。", "Es un estado de datos faltantes, no un período de uso cero."],
  "dashboard.timeline.newerBuildTitle": ["A newer build is required to read this timeline", "需要较新版本才能读取此时间线", "Se necesita una versión más reciente para leer esta cronología"],
  "dashboard.timeline.unavailableTitle": ["Usage timeline unavailable", "使用情况时间线不可用", "Cronología de uso no disponible"],
  "dashboard.timeline.observedQuota": ["Observed quota change", "观测到的额度变化", "Cambio de cuota observado"],
  "dashboard.timeline.expectedCost": ["Expected from speed-priced API cost", "按按速度档定价 API 成本推断的预期变化", "Esperado según el coste de API con precio según velocidad"],
  "dashboard.timeline.percentagePoints": ["Percentage points", "百分点", "Puntos porcentuales"],
  "dashboard.timeline.movementTitle": ["{window} rolling quota movement", "{window} 滚动额度变化", "Movimiento móvil de cuota de {window}"],
  "dashboard.timeline.chartDescription": ["Observed quota movement compared with movement implied by speed-priced priced token usage, including published Fast (Priority) price ratios. Times are shown in {timeZone}.", "将观测到的额度变化与按按速度档定价的定价令牌使用量推断的变化进行比较，其中包括已公布的 Fast（Priority）价格倍率。时间显示为 {timeZone}。", "Movimiento de cuota observado comparado con el movimiento implícito por uso de tokens con precio con precio según velocidad, incluidos los multiplicadores de precio Fast (Priority) publicados. Las horas se muestran en {timeZone}."],
  "dashboard.timeline.lowConfidence": ["Low confidence: only {visible}; {excluded}.", "置信度较低：仅显示 {visible}；{excluded}。", "Confianza baja: solo {visible}; {excluded}."],
  "dashboard.timeline.excludedShown": ["{shown}. {excluded}. Excluded windows are shaded above; do not read them as zero usage.", "{shown}。{excluded}。被排除的窗口在上方以阴影显示；不要将它们理解为零使用。", "{shown}. {excluded}. Las ventanas excluidas se muestran sombreadas arriba; no las interpretes como uso cero."],
  "dashboard.timeline.exclusionJoin": ["; ", "；", "; "],
  "dashboard.timeline.noExclusions": ["no windows are excluded", "没有窗口被排除", "ninguna ventana está excluida"],
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
  "chart.axis.apiEquivalentPerHour": ["$ Standard API equivalent per hour", "每小时的 Standard API 等价美元", "$ equivalente de API Standard por hora"],
  "chart.axis.apiEquivalentPerDay": ["$ Standard API equivalent per day", "每天的 Standard API 等价美元", "$ equivalente de API Standard por día"],
  "chart.axis.apiEquivalentPerWeek": ["$ Standard API equivalent per week", "每周的 Standard API 等价美元", "$ equivalente de API Standard por semana"],
  "chart.axis.apiEquivalentPerInterval": ["$ Standard API equivalent per interval", "每个间隔的 Standard API 等价美元", "$ equivalente de API Standard por intervalo"],
  "chart.axis.quotaWeightedPerHour": ["$ speed-priced API equivalent per hour", "每小时的按速度档定价 API 等价美元", "$ equivalente de API con precio según velocidad por hora"],
  "chart.axis.quotaWeightedPerDay": ["$ speed-priced API equivalent per day", "每天的按速度档定价 API 等价美元", "$ equivalente de API con precio según velocidad por día"],
  "chart.axis.quotaWeightedPerWeek": ["$ speed-priced API equivalent per week", "每周的按速度档定价 API 等价美元", "$ equivalente de API con precio según velocidad por semana"],
  "chart.axis.quotaWeightedPerInterval": ["$ speed-priced API equivalent per interval", "每个间隔的按速度档定价 API 等价美元", "$ equivalente de API con precio según velocidad por intervalo"],
  "chart.axis.apiEquivalentPerSevenDays": ["$ speed-priced API equivalent per seven-day allowance", "每个七天额度的按速度档定价 API 等价美元", "$ equivalente de API con precio según velocidad por asignación de siete días"],
  "chart.axis.sevenDayAllowanceRemaining": ["Seven-day allowance remaining (%)", "七天额度剩余（%）", "Asignación de siete días restante (%)"],
  "chart.series.apiEquivalentUsage": ["API-price-equivalent usage", "API 价格等价使用量", "Uso equivalente al precio de API"],
  "chart.series.quotaWeightedUsage": ["Speed-priced API-equivalent usage", "按速度档定价 API 等价使用量", "Uso equivalente de API con precio según velocidad"],
  "chart.series.standardApiUsage": ["Standard-rate API-equivalent usage", "Standard 费率 API 等价使用量", "Uso equivalente de API con tarifa Standard"],
  "chart.series.sevenDayAllowanceRemaining": ["Seven-day allowance remaining", "七天额度剩余", "Asignación de siete días restante"],
  "chart.usage.title": ["Real local speed-priced API-equivalent usage over time", "真实本地按速度档定价 API 等价使用量随时间变化", "Uso local real equivalente de API con precio según velocidad a lo largo del tiempo"],
  "chart.usage.description": ["Local speed-priced API-equivalent usage per {unit}, using recorded or selected Codex speed and published Fast (Priority) price ratios, with the provider-observed seven-day allowance remaining on the right axis. Times are shown in {timeZone}.", "按{unit}显示的本地按速度档定价 API 等价使用量，使用已记录或所选的 Codex 速度及经审核的 Fast 倍数；右轴为提供方观测到的七天额度剩余。时间显示为 {timeZone}。", "Uso local equivalente de API con precio según velocidad por {unit}, con la velocidad de Codex registrada o seleccionada y multiplicadores de precio Fast (Priority) publicados; la cuota restante de siete días observada por el proveedor aparece en el eje derecho. Las horas se muestran en {timeZone}."],
  "chart.usage.heading": ["Speed-priced API-equivalent usage by {unit} · latest {range}", "按{unit}的按速度档定价 API 等价使用量 · 最近 {range}", "Uso equivalente de API con precio según velocidad por {unit} · periodo reciente: {range}"],
  "chart.usage.standardTitle": ["Standard-rate API-equivalent usage over time", "Standard 费率 API 等价使用量随时间变化", "Uso equivalente de API con tarifa Standard a lo largo del tiempo"],
  "chart.usage.standardDescription": ["Local Standard-rate API-equivalent usage per {unit}. The allowance series is omitted because no matching speed-priced capacity is available. Times are shown in {timeZone}.", "按{unit}显示的本地 Standard 费率 API 等价使用量。由于没有匹配的按速度档定价容量，因此不显示额度序列。时间显示为 {timeZone}。", "Uso local equivalente de API con tarifa Standard por {unit}. Se omite la serie de cuota porque no hay una capacidad ponderada coincidente. Las horas se muestran en {timeZone}."],
  "chart.usage.standardHeading": ["Standard-rate API-equivalent usage by {unit} · latest {range}", "按{unit}的 Standard 费率 API 等价使用量 · 最近 {range}", "Uso equivalente de API con tarifa Standard por {unit} · periodo reciente: {range}"],
  "chart.usage.emptyTitle": ["No real usage timeline loaded", "未加载真实使用情况时间线", "No se cargó ninguna cronología de uso real"],
  "chart.usage.emptyCopy": ["Analyze local usage to build recent content-free usage buckets.", "分析本地使用情况以构建近期不含内容的使用分桶。", "Analiza el uso local para crear intervalos recientes de uso sin contenido."],
  "chart.usage.newerBuildTitle": ["A newer build is required to read this usage history", "需要较新版本才能读取此使用历史记录", "Se necesita una versión más reciente para leer este historial de uso"],
  "chart.usage.unavailableTitle": ["Usage history unavailable", "使用历史记录不可用", "Historial de uso no disponible"],
  "chart.usage.aria": ["Interactive usage timeline in {timeZone}. Use plus or minus to zoom, arrow keys to pan, Home to reset, or drag horizontally.", "{timeZone} 的交互式使用情况时间线。使用加号或减号缩放，方向键平移，Home 重置，或水平拖动。", "Cronología interactiva de uso en {timeZone}. Usa más o menos para ampliar, las flechas para desplazar, Inicio para restablecer o arrastra horizontalmente."],
  "chart.unit.hour": ["hour", "小时", "hora"],
  "chart.unit.day": ["day", "天", "día"],
  "chart.unit.week": ["week", "周", "semana"],
  "chart.unit.interval": ["interval", "间隔", "intervalo"],
  "chart.residual.series": ["Residual", "残差", "Residuo"],
  // The cumulative view (owner-directed, 2026-08-08): a running per-bucket
  // sum re-anchored at each reset boundary or track change, named as exactly
  // that.
  "chart.residual.cumulativeSeries": ["Cumulative drift since boundary", "自边界以来的累计漂移", "Deriva acumulada desde el límite"],
  "chart.residual.title": ["Quota movement residuals", "额度变化残差", "Residuos del movimiento de cuota"],
  "chart.residual.description": ["Observed quota change minus the speed-priced API-cost-implied change, over the same date range as the calibration chart. Reviewed Fast multipliers apply to eligible buckets. Windows with no computable weighted residual are left as shaded gaps. The cumulative line sums each bucket's observed-minus-expected movement and restarts at every window boundary or track change. Times are shown in {timeZone}.", "观测到的额度变化减去按按速度档定价 API 成本推断的变化，日期范围与校准图相同。符合条件的分桶会应用已公布的 Fast（Priority）价格倍率。没有可计算加权残差的窗口保留为阴影缺口。累计线将每个分桶的“观测减预期”变化相加，并在每个窗口边界或额度轨道变化处重新开始。时间显示为 {timeZone}。", "Cambio de cuota observado menos el cambio implícito por coste de API con precio según velocidad, en el mismo intervalo que el gráfico de calibración. Los multiplicadores de precio Fast (Priority) publicados se aplican a los intervalos elegibles. Las ventanas sin residuo ponderado calculable quedan como huecos sombreados. La línea acumulada suma el movimiento observado menos esperado y se reinicia en cada límite o cambio de seguimiento. Las horas se muestran en {timeZone}."],
  "chart.status.matched": ["Matched quota bracket", "匹配的额度区间", "Intervalo de cuota coincidente"],
  "chart.status.inactive": ["No local activity or quota movement", "没有本地活动或额度变化", "Sin actividad local ni movimiento de cuota"],
  "chart.status.unpricedLocalActivity": ["Usage change without reviewed price", "没有经审核价格的使用变化", "Cambio de uso sin precio revisado"],
  "chart.status.quotaWeightingUnavailable": ["Speed pricing unavailable", "按速度档定价不可用", "Ponderación por cuota no disponible"],
  "chart.status.unexplainedWithoutLocalActivity": ["Quota movement without a local usage change", "没有本地使用变化的额度变动", "Movimiento de cuota sin cambio de uso local"],
  "chart.status.missingQuotaBracket": ["Quota bracket not recorded", "未记录额度区间", "Intervalo de cuota no registrado"],
  "chart.status.resetOrTrackChange": ["Window boundary or track change", "窗口边界或额度轨道变化", "Límite de ventana o cambio de seguimiento"],
  "chart.status.backwardOrAmbiguous": ["Movement needs context", "变化需要上下文", "El movimiento necesita contexto"],
  // The pool is pegged at 100%: the display cannot move while cost accrues,
  // so the span is a deliberate suspension, never an over-cost reading.
  "chart.status.poolSaturated": ["Allowance exhausted", "额度已用尽", "Asignación agotada"],
  "chart.status.historical": ["Historical calibration point", "历史校准点", "Punto de calibración histórico"],

  // Weekly allowance history. The headline deliberately never follows the
  // chart controls, so its own copy has to say which population it summarizes
  // and how many of those estimates the chart is currently drawing.
  "weekly.headline.label": ["Speed-priced all-data median", "按速度档定价的全部数据中位数", "Mediana con precio según velocidad de todos los datos"],
  "weekly.headline.planLabel": ["{plan} · speed-priced median", "{plan} · 按速度档定价的中位数", "{plan} · mediana con precio según velocidad"],
  "weekly.headline.planRange": ["80% across-reset range for {plan}: {lower}–{upper}", "{plan} 的 80% 跨重置区间：{lower}–{upper}", "Intervalo del 80 % entre restablecimientos de {plan}: {lower}–{upper}"],
  "weekly.plan.label": ["Plan", "方案", "Plan"],
  "weekly.plan.aria": ["Allowance history plan", "额度历史方案", "Plan del historial de cuota"],
  "weekly.plan.unknown": ["Plan unreported", "未报告方案", "Plan no informado"],
  "weekly.plan.latestOption": ["{plan} · latest observed", "{plan} · 最近观测", "{plan} · último observado"],
  "weekly.plan.historyOption": ["{plan} · history", "{plan} · 历史", "{plan} · historial"],
  "weekly.plan.conditional": ["History is grouped by the plan recorded at the time. Earlier account identity is unverified.", "历史记录按当时报告的方案分组。早期账户身份尚未验证。", "El historial se agrupa por el plan registrado en ese momento. La identidad de las cuentas anteriores no está verificada."],
  "weekly.plan.historicalConditional": ["Showing {plan} history, with earlier account identity unverified. Current allowance and pace apply only to the latest observed plan.", "显示 {plan} 历史记录，早期账户身份尚未验证。当前额度和使用速度仅适用于最近观测的方案。", "Se muestra el historial de {plan}, sin verificar la identidad de las cuentas anteriores. La cuota y el ritmo actuales solo corresponden al último plan observado."],
  "weekly.plan.comparisonConditional": ["Historical comparison for {plan}; account identity is unverified.", "{plan} 的历史比较；账户身份尚未验证。", "Comparación histórica de {plan}; la identidad de la cuenta no está verificada."],
  "weekly.plan.comparisonPending": ["The comparison needs usage and quota matched to one plan. Your usage and plan histories are kept.", "此比较需要使用量与额度匹配到同一方案。您的使用量和方案历史记录均已保留。", "La comparación necesita uso y cuota asociados al mismo plan. Se conservan los historiales de uso y de planes."],
  "weekly.headline.value": ["{amount} API equivalent", "{amount} API 等价值", "{amount} equivalente de API"],
  "weekly.headline.insufficient": ["Insufficient evidence", "证据不足", "Evidencia insuficiente"],
  "weekly.headline.range": ["80% across-reset range, all data: {lower}–{upper}", "全部数据的 80% 跨重置区间：{lower}–{upper}", "Intervalo del 80 % entre restablecimientos, todos los datos: {lower}–{upper}"],
  "weekly.headline.rangeUnavailable": ["No evidence interval available", "没有可用的证据区间", "No hay intervalo de evidencia disponible"],
  "weekly.headline.relationship": ["The headline is the median of all {qualifying} qualifying reset estimates and never moves with the controls below. The chart is currently drawing {shown} of {total} estimates: the selected range, anchored at the newest fit ({anchor}), with observed quota spans of {span}.", "标题为全部 {qualifying} 个合格重置估计的中位数，不会随下方控件变化。图表当前绘制 {total} 个估计中的 {shown} 个：所选范围以最新拟合（{anchor}）为锚点，且观测额度跨度为{span}。", "El titular es la mediana de las {qualifying} estimaciones de restablecimiento válidas y nunca cambia con los controles de abajo. El gráfico dibuja actualmente {shown} de {total} estimaciones: el intervalo seleccionado, anclado en el ajuste más reciente ({anchor}), con intervalos de cuota observada de {span}."],
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
  // Honest name (estimator audit, 2026-08-08): the per-reset bars are the
  // p10–p90 spread of pairwise slopes WITHIN a reset — a disagreement
  // diagnostic, not a measured confidence interval.
  "weekly.series.measuredRange": ["Slope-agreement range", "斜率一致性区间", "Intervalo de concordancia de pendientes"],
  "weekly.point.detail": ["{span} observed · slope-agreement range {low}–{high}", "已观测 {span} · 斜率一致性区间 {low}–{high}", "{span} observado · concordancia de pendientes {low}–{high}"],
  "weekly.chart.title": ["Seven-day allowance estimate history", "七天额度估计历史", "Historial de estimaciones de la asignación de siete días"],
  "weekly.chart.description": ["One estimate per observed seven-day reset, each with an observed quota span of {span}. The flat line is the all-data median that the headline reports. Slope-agreement ranges stay available on hover and focus. Times are shown in {timeZone}.", "每个观测到的七天重置对应一个估计，其观测额度跨度为{span}。水平线是标题所报告的全部数据中位数。斜率一致性区间在悬停和聚焦时仍可查看。时间显示为 {timeZone}。", "Una estimación por cada restablecimiento de siete días observado, cada una con un intervalo de cuota observada de {span}. La línea plana es la mediana de todos los datos que informa el titular. Los intervalos de concordancia de pendientes siguen disponibles al pasar el cursor y al enfocar. Las horas se muestran en {timeZone}."],
  "weekly.chart.empty": ["No weekly estimates loaded.", "未加载每周估计。", "No se cargaron estimaciones semanales."],
  "weekly.chart.emptyRange": ["No reset estimates fall inside the selected range.", "所选范围内没有任何重置估计。", "Ninguna estimación de restablecimiento cae dentro del intervalo seleccionado."],
  "weekly.table.empty": ["No weekly evidence loaded.", "未加载每周证据。", "No se cargó evidencia semanal."],
  "weekly.table.wellObserved": ["Well observed", "观测充分", "Bien observado"],
  "weekly.table.spanNotRecorded": ["Span not recorded", "未记录跨度", "Intervalo no registrado"],
  "residual.table.notComparable": ["Not comparable", "不可比较", "No comparable"],
  "residual.table.empty": ["No periods loaded.", "未加载任何时段。", "No se cargaron períodos."],
  // The exact-windows pager (owner-directed, 2026-08-08): the shown range of
  // the full merged inspection list.
  "residual.table.page": ["{start}–{end} of {total}", "第 {start}–{end} 项，共 {total} 项", "{start}–{end} de {total}"],
  "weekly.table.page": ["{start}–{end} of {total}", "第 {start}–{end} 项，共 {total} 项", "{start}–{end} de {total}"],
  "table.pagination.previous": ["Previous", "上一页", "Anterior"],
  "table.pagination.next": ["Next", "下一页", "Siguiente"],
  "table.pagination.page": ["{start}–{end} of {total}", "第 {start}–{end} 项，共 {total} 项", "{start}–{end} de {total}"],
  // The signed-AUC drift figure beside MAE and peak (owner-directed,
  // 2026-08-08). The unit is percentage-point-hours.
  "dashboard.summary.cumulativeDrift": ["Cumulative drift", "累计漂移", "Deriva acumulada"],
  "dashboard.summary.cumulativeDriftExplanation": [
    "The signed area under the visible residual series: observed-minus-expected percentage points integrated over hours. Positive means observed quota movement ran ahead of what recorded cost implies.",
    "可见残差序列下的带符号面积：以小时积分的“观测减预期”百分点。为正表示观测到的额度变化超过了记录成本所推断的变化。",
    "El área con signo bajo la serie de residuos visible: puntos porcentuales observados menos esperados integrados en horas. Un valor positivo significa que el movimiento de cuota observado superó lo que implica el coste registrado.",
  ],
  "dashboard.summary.sideChatBaseline": ["Before side-chat estimate", "加入侧聊估算之前", "Antes de estimar chats laterales"],
  "dashboard.summary.sideChatBaselineExplanation": ["The same signed area using only the exact local usage ledger. Comparing it with cumulative drift isolates the effect of the experimental side-chat estimate.", "仅使用精确本地使用账本时的同一带符号面积。将其与累计漂移比较，可单独看出实验性侧聊估算的影响。", "La misma área con signo usando solo el registro local exacto. Compararla con la deriva acumulada aísla el efecto de la estimación experimental de chats laterales."],
  "dashboard.summary.sideChatAdjustment": ["Side-chat adjustment", "侧聊调整", "Ajuste por chats laterales"],
  "dashboard.summary.sideChatAdjustmentExplanation": ["Adjusted cumulative drift minus the exact-ledger baseline. A negative value means the estimated side-chat usage moved the cost-implied line upward.", "调整后的累计漂移减去精确账本基线。负值表示估算的侧聊使用量使成本推断线向上移动。", "Deriva acumulada ajustada menos la base del registro exacto. Un valor negativo significa que el uso estimado de chats laterales elevó la línea implícita por coste."],
  "dashboard.summary.sideChatNoMatchedOverlap": ["No matched overlap", "无匹配重叠", "Sin solapamiento comparable"],
  "dashboard.summary.sideChatAdjustmentNoOverlapExplanation": [
    "The retained side-chat estimates do not overlap any currently matched quota windows, so their effect on residual area is not testable from this evidence.",
    "保留的侧聊估算与当前任何已匹配的额度窗口都不重叠，因此无法依据这些证据检验其对残差面积的影响。",
    "Las estimaciones conservadas de chats laterales no coinciden con ninguna ventana de cuota comparable actual, por lo que estas pruebas no permiten medir su efecto sobre el área residual.",
  ],
  "format.ppHours": ["{value} pp·h", "{value} 个百分点·小时", "{value} pp·h"],
  // The deviation-period detector's Trends panel: sustained stretches where
  // observed quota movement and priced (cost-implied) usage persistently
  // disagree. Copy stays honest — a period is a finding to review, never proof
  // of a billing error.
  "divergence.dateRange": ["{start} → {end}", "{start} → {end}", "{start} → {end}"],
  "divergence.duration": ["over {duration}", "持续 {duration}", "durante {duration}"],
  "divergence.underCosted": [
    "Observed quota fell about {pp} more than priced usage explains — likely under-counted here.",
    "观测到的额度下降比按价格计算的用量所能解释的多出约 {pp}——这里很可能被少计。",
    "La cuota observada bajó unos {pp} más de lo que explica el uso con precio: probablemente se subestimó aquí.",
  ],
  "divergence.overCosted": [
    "Observed quota fell about {pp} short of what priced usage predicted — likely over-counted or credited here.",
    "观测到的额度下降比按价格计算的用量所预测的少约 {pp}——这里很可能被多计或有额度返还。",
    "La cuota observada bajó unos {pp} menos de lo que predijo el uso con precio: probablemente se sobrestimó o se acreditó aquí.",
  ],
  "divergence.magnitude": [
    "Peak drift {peak} · signed area {auc}",
    "峰值漂移 {peak} · 带符号面积 {auc}",
    "Deriva máxima {peak} · área con signo {auc}",
  ],
  "divergence.mix": [
    "This window: {cost} priced usage across {tokens} tokens in {events} usage changes.",
    "此窗口：{cost} 的计价用量，涵盖 {tokens} 个令牌、{events} 次用量变化。",
    "Esta ventana: {cost} de uso con precio en {tokens} tokens y {events} cambios de uso.",
  ],
  "divergence.unpricedShare": [
    "{share} of usage changes in this window carry no published price.",
    "此窗口中有 {share} 的用量变化没有已公布的价格。",
    "El {share} de los cambios de uso de esta ventana no tienen un precio publicado.",
  ],
  "divergence.rangeMix": [
    "Range mix (whole selected period, not just this window): mostly {model}, {speed} speed.",
    "范围构成（整个所选时段，而非仅此窗口）：以 {model} 为主，{speed} 速度。",
    "Mezcla del intervalo (todo el período seleccionado, no solo esta ventana): sobre todo {model}, velocidad {speed}.",
  ],
  "divergence.breakdown.show": [
    "Show this window's cost mix",
    "显示此窗口的成本构成",
    "Mostrar la mezcla de costes de esta ventana",
  ],
  "divergence.breakdown.hide": [
    "Hide this window's cost mix",
    "隐藏此窗口的成本构成",
    "Ocultar la mezcla de costes de esta ventana",
  ],
  "divergence.breakdown.loading": [
    "Repricing this window…",
    "正在重新计价此窗口……",
    "Recalculando el precio de esta ventana…",
  ],
  "divergence.breakdown.modelHeading": [
    "By model (this window)",
    "按模型（此窗口）",
    "Por modelo (esta ventana)",
  ],
  "divergence.breakdown.speedHeading": [
    "By speed (this window)",
    "按速度（此窗口）",
    "Por velocidad (esta ventana)",
  ],
  "divergence.breakdown.modelRow": [
    "{model}: {cost} ({share} of window cost)",
    "{model}：{cost}（占窗口成本的 {share}）",
    "{model}: {cost} ({share} del coste de la ventana)",
  ],
  "divergence.breakdown.speedRow": [
    "{speed}: {cost} across {events} usage changes",
    "{speed}：{cost}，涵盖 {events} 次用量变化",
    "{speed}: {cost} en {events} cambios de uso",
  ],
  "divergence.breakdown.fastCost": [
    "Fast-speed usage: {cost} of this window's priced cost.",
    "快速用量：占此窗口计价成本的 {cost}。",
    "Uso en velocidad rápida: {cost} del coste con precio de esta ventana.",
  ],
  "divergence.breakdown.unpriced": [
    "{share} of this window's usage changes carry no published price.",
    "此窗口中有 {share} 的用量变化没有已公布的价格。",
    "El {share} de los cambios de uso de esta ventana no tienen un precio publicado.",
  ],
  "divergence.breakdown.empty": [
    "No priced usage events in this window.",
    "此窗口中没有已计价的用量事件。",
    "No hay eventos de uso con precio en esta ventana.",
  ],
  "divergence.breakdown.unavailable": [
    "Per-window cost mix is unavailable from this companion — range mix instead: mostly {model}, {speed} speed.",
    "此伴随程序无法提供逐窗口成本构成——改用范围构成：以 {model} 为主，{speed} 速度。",
    "La mezcla de costes por ventana no está disponible en este acompañante; en su lugar, la mezcla del intervalo: sobre todo {model}, velocidad {speed}.",
  ],
  "divergence.breakdown.unavailablePlain": [
    "Per-window cost mix is unavailable from this companion.",
    "此伴随程序无法提供逐窗口成本构成。",
    "La mezcla de costes por ventana no está disponible en este acompañante.",
  ],
  "divergence.empty": [
    "No sustained divergence in this range — observed and priced usage track within the noise band.",
    "此范围内没有持续的背离——观测用量与计价用量在噪声带内保持一致。",
    "Sin divergencia sostenida en este intervalo: el uso observado y el uso con precio coinciden dentro del margen de ruido.",
  ],
  "divergence.emptyNoDrift": [
    "No cumulative-drift series is available for this range yet — open it with the local companion connected to detect divergence periods.",
    "此范围尚无累计漂移序列——请在已连接本地伴随程序的情况下打开，以检测背离时段。",
    "Aún no hay una serie de deriva acumulada para este intervalo: ábrelo con el acompañante local conectado para detectar períodos de divergencia.",
  ],
  "divergence.truncated": [
    "Showing the {shown} widest of {total} detected periods.",
    "在检测到的 {total} 个时段中显示最显著的 {shown} 个。",
    "Mostrando los {shown} más amplios de {total} períodos detectados.",
  ],
  "divergence.methodCaveat": [
    "Known limitation: the expected line prices every model at one blended rate, so a stretch dominated by a single model can read as divergence. A per-model expected line is planned.",
    "已知局限：预期线以单一混合费率为所有模型计价，因此以单一模型为主的时段可能显示为背离。按模型区分的预期线已在计划中。",
    "Limitación conocida: la línea esperada valora todos los modelos con una única tarifa combinada, por lo que un período dominado por un solo modelo puede aparecer como divergencia. Está prevista una línea esperada por modelo.",
  ],
  "divergence.speed.fast": ["fast", "快速", "rápida"],
  "divergence.speed.standard": ["standard", "标准", "estándar"],
  "divergence.speed.unknown": ["unknown", "未知", "desconocida"],
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
  "contribution.signOutFailed": ["The service could not confirm sign-out, so you are still signed in. Nothing was changed; check your connection and try again.", "服务无法确认退出登录，因此你仍处于登录状态。没有任何更改；请检查连接后重试。", "El servicio no pudo confirmar el cierre de sesión, por lo que sigues con la sesión iniciada. No se cambió nada; comprueba tu conexión e inténtalo de nuevo."],
  // Standalone capitalized forms (owner-directed, 2026-08-10): the period is
  // now the whole detail line under Recorded activity — the "event-time API
  // equivalent" caption is gone — so the mid-sentence "the …" phrasing left
  // with it. allRecorded is the range-selected "All" label.
  "share.period.allRecorded": ["All recorded history", "所有记录的历史", "Todo el historial registrado"],
  "share.period.allRetained": ["All retained evidence", "全部保留证据", "Toda la evidencia conservada"],
  "share.period.cachedThirtyOneDay": ["Cached 31-day window", "缓存的 31 天窗口", "Ventana en caché de 31 días"],
  "share.period.cachedThirtyOneDayCollector": ["Cached 31-day collector window", "缓存的 31 天收集器窗口", "Ventana del recopilador en caché de 31 días"],
  "share.period.lastDay": ["Last 24 hours", "过去 24 小时", "Últimas 24 horas"],
  "share.period.lastThirtyDays": ["Last 30 days", "过去 30 天", "Últimos 30 días"],
  "share.period.lastSevenDays": ["Last 7 days", "过去 7 天", "Últimos 7 días"],
  "share.period.recorded": ["Recorded period", "记录的期间", "Período registrado"],
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
  "share.detail.accountingUnavailable": ["usage accounting was unavailable", "使用情况核算不可用", "la contabilidad de uso no estaba disponible"],
  "share.detail.lastVerifiedNewerBuild": ["last verified · {period}; newer build required", "上次验证 · {period}；需要较新版本", "última verificación · {period}; se requiere una versión más reciente"],
  "share.detail.lastVerifiedPeriod": ["last verified · {period}", "上次验证 · {period}", "última verificación · {period}"],
  "share.detail.newerBuildRequired": ["a newer TiboTattle build is required", "需要较新版本的 TiboTattle", "se requiere una versión más reciente de TiboTattle"],
  "share.detail.noPricedUsage": ["no priced usage was recorded", "未记录到已定价的使用量", "no se registró uso con precio"],
  "share.detail.resetRange": ["Observed reset range {lower}–{upper}", "观测到的重置范围 {lower}–{upper}", "Rango de restablecimiento observado: {lower}–{upper}"],
  "share.detail.noAcrossResetRange": ["no across-reset range yet", "尚无跨重置范围", "aún no hay intervalo entre restablecimientos"],
  "share.detail.notEnoughMatchedWindows": ["not enough matched windows yet", "尚无足够的匹配窗口", "aún no hay suficientes ventanas coincidentes"],
  "share.caveat.demo": ["Labeled demo data: an illustrative fixture, not measured usage.", "已标记的演示数据：示例性装置，不是测得的使用量。", "Datos de demostración etiquetados: una muestra ilustrativa, no uso medido."],
  "share.caveat.planConditional": ["Allowance history follows the recorded plan; account identity is unverified. Recorded activity includes all plans.", "额度历史按记录的方案分组；账户身份尚未验证。记录的活动包含所有方案。", "El historial de cuota sigue el plan registrado; la identidad de la cuenta no está verificada. La actividad registrada incluye todos los planes."],
  "share.stat.recordedActivityAllPlans": ["Recorded activity · all plans", "记录的活动 · 所有方案", "Actividad registrada · todos los planes"],
  "share.planAllowance": ["Allowance: {plan}", "额度：{plan}", "Cuota: {plan}"],
  "share.caveat.unweighted": ["Not a complete total: {amount} of Standard-rate cost could not be speed-weighted and is excluded rather than counted at 1x.", "不是完整总额：{amount} 的 Standard 费率成本无法按速度加权，因此被排除而不是按 1 倍计入。", "No es un total completo: {amount} de coste a tarifa Standard no pudo ponderarse por velocidad y se excluye en lugar de contarse a 1×."],
  "share.caveat.noWeighted": ["No usage could be speed-weighted, so this is the unchanged Standard-rate total.", "没有使用量可按速度加权，因此这是未变动的 Standard 费率总额。", "No se pudo ponderar ningún uso por velocidad, por lo que este es el total sin cambios a tarifa Standard."],
  "share.caveat.fastPartial": ["Fast-mode attribution is partial: Codex records the speed mode only when it changes, never at session start.", "Fast 模式归因不完整：Codex 仅在速度模式改变时记录，绝不会在会话开始时记录。", "La atribución del modo Fast es parcial: Codex registra el modo de velocidad solo cuando cambia, nunca al inicio de la sesión."],
  "share.caveat.coverage": ["{percent} of recorded usage changes have a reviewed public price; the remainder is omitted from the estimate.", "记录的使用变化中有 {percent} 具备经审核的公开价格；其余部分不纳入估算。", "El {percent} de los cambios de uso registrados tiene un precio público revisado; el resto queda fuera de la estimación."],
  "share.title": ["What my Codex allowance is really worth", "我的 Codex 额度到底值多少", "Lo que realmente vale mi asignación de Codex"],
  "share.subtitle.demo": ["Illustrative demo data. Not a measurement.", "示例性演示数据。不是测量结果。", "Datos de demostración ilustrativos. No son una medición."],
  "share.badge.demo": ["DEMO DATA", "演示数据", "DATOS DEMO"],
  "share.plan": ["Plan {plan}", "套餐 {plan}", "Plan {plan}"],
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
  "share.range.all": ["all history", "全部历史", "todo el historial"],
  "share.range.days": ["{days}d", "{days} 天", "{days} d"],
  "share.trend.countWithFloor": ["{shown} of {total} reset fits ({range}, ≥{span}pp span)", "{total} 个重置拟合中显示 {shown} 个（{range}，跨度 ≥{span}pp）", "{shown} de {total} ajustes de restablecimiento ({range}, intervalo ≥{span}pp)"],
  "share.trend.countAnySpan": ["{shown} of {total} reset fits ({range}, any span)", "{total} 个重置拟合中显示 {shown} 个（{range}，任意跨度）", "{shown} de {total} ajustes de restablecimiento ({range}, cualquier intervalo)"],
  "share.text.trailer": ["{trailer}.", "{trailer}。", "{trailer}."],
  "share.text.more": ["More at {home}", "更多信息：{home}", "Más en {home}"],
  "share.text.trendEmpty": ["{label}: {empty} {detail}", "{label}：{empty}{detail}", "{label}: {empty} {detail}"],
  "share.text.trendPopulated": ["{label}: {fits} observed from {start} to {end}. The vertical axis is speed-priced API equivalent in dollars, spanning {low} to {high} including every measured range.", "{label}：从 {start} 到 {end} 观测到 {fits}。纵轴为美元按速度档定价 API 等价值，范围从 {low} 到 {high}，包含每个测得的区间。", "{label}: se observaron {fits} de {start} a {end}. El eje vertical es equivalente de API con precio según velocidad en dólares y abarca de {low} a {high}, incluidos todos los rangos medidos."],
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
  "aria.choosePlatform": ["Choose TiboTattle for your platform", "选择适合你平台的 TiboTattle", "Elige TiboTattle para tu plataforma"],
  "aria.getTiboTattleForMac": ["Get TiboTattle for Mac", "获取适用于 Mac 的 TiboTattle", "Obtén TiboTattle para Mac"],
  "aria.installWithHomebrew": ["Install with Homebrew", "使用 Homebrew 安装", "Instalar con Homebrew"],
  "aria.copyHomebrewCommand": ["Copy Homebrew install command", "复制 Homebrew 安装命令", "Copiar el comando de instalación de Homebrew"],
  "aria.copyInstallerSha256": ["Copy the published SHA-256 checksum", "复制已发布的 SHA-256 校验和", "Copiar la suma de comprobación SHA-256 publicada"],
  "aria.installerSha256": ["SHA-256 checksum", "SHA-256 校验和", "Suma de comprobación SHA-256"],
  "aria.tibotattleFeatures": ["What TiboTattle provides", "TiboTattle 提供的功能", "Qué ofrece TiboTattle"],
  "aria.findTiboTattleOnline": ["Find TiboTattle online", "在线查找 TiboTattle", "Encuentra TiboTattle en línea"],
  "aria.githubExternal": ["GitHub (opens in a new tab)", "GitHub（在新标签页中打开）", "GitHub (se abre en una pestaña nueva)"],
  "aria.xExternal": ["X (opens in a new tab)", "X（在新标签页中打开）", "X (se abre en una pestaña nueva)"],
  "alt.previewWeeklyHistory": ["Sample seven-day allowance history with reset-level uncertainty ranges", "带有重置级别不确定性范围的七天额度历史示例", "Ejemplo de historial de asignación de siete días con intervalos de incertidumbre por restablecimiento"],
  "aria.shareCard": ["A results card is generated once local evidence is available.", "本地证据可用后会生成结果卡片。", "Se genera una tarjeta de resultados cuando hay evidencia local disponible."],
  "aria.weeklyHistoryRange": ["Weekly history date range", "每周历史日期范围", "Intervalo de fechas del historial semanal"],
  "aria.allowanceRange": ["Allowance estimate date range", "额度估计日期范围", "Intervalo de fechas de la estimación de asignación"],
  "aria.expandCommunityAllowanceChart": ["Expand community allowance chart", "放大社区额度图表", "Ampliar el gráfico de asignación comunitaria"],
  "aria.closeCommunityAllowanceChart": ["Close expanded community allowance chart", "关闭放大的社区额度图表", "Cerrar el gráfico ampliado de asignación comunitaria"],
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
  "aria.contributionJourney": ["Contribution journey stages", "贡献流程阶段", "Etapas del recorrido de contribución"],
  "journey.state.done": ["Done", "已完成", "Hecho"],
  "journey.state.inProgress": ["In progress", "进行中", "En curso"],
  "journey.state.actionNeeded": ["Action needed", "需要操作", "Acción necesaria"],
  "journey.state.waiting": ["Waiting", "等待中", "En espera"],
  // The journey strip is two boxes (owner-directed, 2026-08-10): the
  // "Mac app & companion" stage was self-referential and its keys left with
  // it, and the "Local evidence" observation time now rides as the index
  // line's second clause via the …WithEvidence variants below.
  "journey.index.progress": [
    "Indexing {indexed} of {total} sources.",
    "正在索引 {total} 个来源中的第 {indexed} 个。",
    "Indexando {indexed} de {total} fuentes.",
  ],
  "journey.index.progressWithEvidence": [
    "Indexing {indexed} of {total} sources · latest observation {time}.",
    "正在索引 {total} 个来源中的第 {indexed} 个 · 最新观测 {time}。",
    "Indexando {indexed} de {total} fuentes · última observación {time}.",
  ],
  "journey.index.complete": [
    "The discovered history is fully indexed.",
    "已发现的历史记录已全部编入索引。",
    "El historial descubierto está completamente indexado.",
  ],
  "journey.index.completeWithEvidence": [
    "History indexed · latest observation {time}.",
    "历史已索引 · 最新观测 {time}。",
    "Historial indexado · última observación {time}.",
  ],
  "journey.index.waiting": [
    "Waiting for the first local analysis.",
    "正在等待第一次本地分析。",
    "A la espera del primer análisis local.",
  ],
  // The companion's health answer, not the companion itself: this page is
  // served BY the Mac app, so a line about waiting for the Mac app describes
  // something the reader can see is untrue. These two state the real fact —
  // no answer to a status check yet — and differ on the one thing the reader
  // can act on: whether another attempt is still coming.
  "journey.community.waitingHealth": [
    "The Mac app has not answered a status check yet. Checking again.",
    "Mac 应用尚未响应状态检查。正在重新检查。",
    "La app para Mac aún no responde a una comprobación de estado. Reintentando.",
  ],
  "journey.community.noHealthAnswer": [
    "The Mac app has not answered a status check. Reload to try again.",
    "Mac 应用未响应状态检查。请重新加载页面再试。",
    "La app para Mac no respondió a una comprobación de estado. Recarga para reintentar.",
  ],
  "journey.community.noService": [
    "This build has no contribution service.",
    "此构建没有贡献服务。",
    "Esta compilación no tiene servicio de contribución.",
  ],
  "journey.community.paused": [
    "New community sign-ups are paused.",
    "社区新注册已暂停。",
    "Las nuevas inscripciones a la comunidad están en pausa.",
  ],
  "journey.community.signInFirst": [
    "Sign in below with Google or Apple.",
    "请在下方使用 Google 或 Apple 登录。",
    "Inicia sesión abajo con Google o Apple.",
  ],
  "journey.community.connected": [
    "Connected.",
    "已连接。",
    "Conectado.",
  ],
  "journey.community.waitingIndex": [
    "Approval opens once the local index is ready.",
    "本地索引就绪后即可核准。",
    "La aprobación se abre cuando el índice local esté listo.",
  ],
  "journey.community.approveNext": [
    "Signed in — review and approve below.",
    "已登录——请在下方审阅并核准。",
    "Sesión iniciada: revisa y aprueba abajo.",
  ],
  "journey.community.syncing": [
    "Approved — your history syncs automatically.",
    "已核准——你的历史将自动同步。",
    "Aprobado: tu historial se sincroniza automáticamente.",
  ],
  // The pending re-pair's two honest stage lines (owner-reported
  // contradictory state, 2026-08-08): "done · syncing" may not render while
  // the approve card is asking for a sign-in.
  "journey.community.signInAgain": [
    "Sign in again to finish reconnecting this Mac.",
    "请重新登录以完成这台 Mac 的重新连接。",
    "Inicia sesión de nuevo para terminar de reconectar este Mac.",
  ],
  "journey.community.refreshingAuthority": [
    "Refreshing this Mac's upload authorization…",
    "正在刷新这台 Mac 的上传授权…",
    "Actualizando la autorización de subida de este Mac…",
  ],
  "syncStatus.verifyingSummary": [
    "Verifying the prepared summary on this Mac. Nothing is sent while it is checked.",
    "正在这台 Mac 上校验已准备的摘要。检查期间不会发送任何内容。",
    "Verificando el resumen preparado en este Mac. No se envía nada mientras se comprueba.",
  ],
  "syncStatus.summaryVerified": [
    "The covered data shown above is verified on this Mac. Nothing uploads without your approval.",
    "上方显示的涵盖数据已在这台 Mac 上完成校验。未经你的核准不会上传任何内容。",
    "Los datos cubiertos mostrados arriba están verificados en este Mac. No se sube nada sin tu aprobación.",
  ],
  // A full day of very heavy local activity does not fit the fixed
  // reviewed-set size bound, and the bootstrap narrows to the latest hour on
  // its own. Approving is a decision about what this review shows, so the
  // narrowing is stated rather than left for the reader to infer.
  "syncStatus.summaryVerifiedNarrowed": [
    "The covered data shown above is verified on this Mac. A full day exceeded a fixed reviewed-set size bound, so this review covers the latest hour instead. Nothing uploads without your approval.",
    "上方显示的涵盖数据已在这台 Mac 上完成校验。整天的数据超出了固定的审阅集大小上限，因此本次审阅改为涵盖最近一小时。未经你的核准不会上传任何内容。",
    "Los datos cubiertos mostrados arriba están verificados en este Mac. Un día completo superó un límite fijo de tamaño del conjunto de revisión, así que esta revisión cubre la última hora. No se sube nada sin tu aprobación.",
  ],
  "consent.reviewFirst": [
    "TiboTattle is preparing and verifying one real instance of the covered data on this Mac for you to review. Nothing is uploaded.",
    "TiboTattle 正在这台 Mac 上准备并校验一份涵盖数据的真实实例供你审阅。不会上传任何内容。",
    "TiboTattle está preparando y verificando en este Mac una instancia real de los datos cubiertos para que la revises. No se sube nada.",
  ],
  "consent.readyToApprove": [
    "The verified instance above is the review. Approving covers this kind of data from now on.",
    "上方经校验的实例即为审阅内容。核准后即涵盖今后同类数据。",
    "La instancia verificada de arriba es la revisión. Aprobar cubre este tipo de datos de ahora en adelante.",
  ],
  "attributionConsent.title": ["Separate account and plan evidence", "区分账户与方案证据", "Separar evidencia de cuentas y planes"],
  "attributionConsent.description": ["An optional contribution update can keep observed plans and pseudonymous account tracks separate. It needs a new review and approval.", "可选的贡献更新可以区分观测到的方案与假名账户轨迹，需要重新审阅和核准。", "Una actualización opcional puede separar los planes observados y las cuentas seudónimas. Requiere una nueva revisión y aprobación."],
  "attributionConsent.review": ["Review additional fields", "审阅新增字段", "Revisar campos adicionales"],
  "attributionConsent.reviewTitle": ["Review account and plan contribution", "审阅账户与方案贡献", "Revisar contribución de cuentas y planes"],
  "attributionConsent.destination": ["Destination: {destination}", "目标：{destination}", "Destino: {destination}"],
  "attributionConsent.sample": ["Verified sample day {day}: {usage} usage records, {quota} quota observations, {sessions} sessions. Approval covers indexed history and future updates.", "已校验的样本日期 {day}：{usage} 条使用记录、{quota} 条额度观测、{sessions} 个会话。核准涵盖已索引历史和未来更新。", "Día de muestra verificado {day}: {usage} registros de uso, {quota} observaciones de cuota y {sessions} sesiones. La aprobación cubre el historial indexado y las futuras actualizaciones."],
  "attributionConsent.fields.usage": ["Usage fields", "使用量字段", "Campos de uso"],
  "attributionConsent.fields.quota": ["Quota fields", "额度字段", "Campos de cuota"],
  "attributionConsent.fields.session": ["Session fields", "会话字段", "Campos de sesión"],
  "attributionConsent.fields.accountPlanAttribution": ["Account and plan evidence fields", "账户与方案证据字段", "Campos de evidencia de cuentas y planes"],
  "attributionConsent.bases": ["Account evidence: {accounts}. Plan evidence: {plans}. Missing quota values stay null: {nullable}.", "账户证据：{accounts}。方案证据：{plans}。缺失额度值保持为空：{nullable}。", "Evidencia de cuentas: {accounts}. Evidencia de planes: {plans}. Los valores de cuota ausentes siguen siendo nulos: {nullable}."],
  "attributionConsent.privacy": ["Account tracks can link eligible activity within this destination and enrollment. No raw account identifiers, prompts, responses or paths are sent. Missing historical identity stays unknown; observed plans are preserved.", "账户轨迹可以关联同一目标和注册范围内符合条件的活动。不会发送原始账户标识、提示、回复或路径。缺失的历史身份保持未知；已观测的方案会保留。", "Las cuentas seudónimas pueden vincular actividad dentro de este destino e inscripción. No se envían identificadores de cuenta originales, prompts, respuestas ni rutas. La identidad histórica ausente sigue siendo desconocida; se conservan los planes observados."],
  "attributionConsent.confirm": ["I approve ongoing upload of these fields, including pseudonymous account and plan linkage.", "我核准持续上传这些字段，包括假名账户与方案关联。", "Apruebo la carga continua de estos campos, incluida la vinculación seudónima de cuentas y planes."],
  "attributionConsent.approve": ["Approve account and plan contribution", "核准账户与方案贡献", "Aprobar contribución de cuentas y planes"],
  "attributionConsent.cancel": ["Not now", "暂不", "Ahora no"],
  "attributionConsent.reviewing": ["Preparing the local review…", "正在准备本地审阅…", "Preparando la revisión local…"],
  "attributionConsent.repairBeforeReview": [
    "Choose Repair connection for your existing sharing setting first. After its sync finishes, review and approve these additional fields separately.",
    "请先为现有共享设置选择修复连接。同步完成后，再单独审阅并核准这些新增字段。",
    "Primero elige Reparar conexión para tu configuración actual. Cuando termine la sincronización, revisa y aprueba estos campos adicionales por separado.",
  ],
  "attributionConsent.approving": ["Recording your separate approval…", "正在记录您的单独核准…", "Registrando tu aprobación por separado…"],
  "attributionConsent.approved": ["Account and plan contribution is approved. Historical identity remains unknown where evidence is missing.", "账户与方案贡献已核准。缺乏证据的历史身份仍保持未知。", "La contribución de cuentas y planes está aprobada. La identidad histórica sigue siendo desconocida cuando faltan pruebas."],
  "attributionConsent.reviewUnavailable": ["This review is not available right now. Your sharing setting is unchanged.", "目前无法进行此审阅。您的共享设置未更改。", "Esta revisión no está disponible ahora. Tu configuración de contribución no ha cambiado."],
  "attributionConsent.approvalIncomplete": ["Approval could not finish. Review again to continue; your local history is unchanged.", "核准未能完成。请重新审阅以继续；您的本地历史记录未更改。", "La aprobación no pudo completarse. Vuelve a revisar para continuar; tu historial local no ha cambiado."],
  "consent.signInFirst": [
    "Sign in above first. Nothing can upload without it.",
    "请先在上方登录。未登录时无法上传任何内容。",
    "Primero inicia sesión arriba. Sin ello no se puede subir nada.",
  ],
  // The repair fallback (owner-reported repair loop, 2026-08-08): the service
  // rejected the stored session, so the page cleared it and asks for the one
  // action that fixes it. Deliberately not failure copy — nothing the user
  // did failed, the approval stands, and the ceremony resumes by itself after
  // the sign-in.
  "consent.signInAgainToFinish": [
    "Sign in again to finish connecting this Mac. Your approval still stands, and connecting resumes automatically after you sign in. Nothing was uploaded.",
    "请重新登录以完成这台 Mac 的连接。你的核准仍然有效，登录后连接会自动继续。未上传任何内容。",
    "Inicia sesión de nuevo para terminar de conectar este Mac. Tu aprobación sigue vigente y la conexión se reanuda automáticamente tras iniciar sesión. No se cargó nada.",
  ],
  "consent.preparingReview": [
    "Preparing one real instance of the covered data on this Mac for you to review. No network upload is performed.",
    "正在这台 Mac 上准备一份涵盖数据的真实实例供你审阅。不会执行任何网络上传。",
    "Preparando en este Mac una instancia real de los datos cubiertos para que la revises. No se realiza ninguna subida de red.",
  ],
  "consent.reviewUnavailable": [
    "TiboTattle could not read the local review state. Choose Check again. Nothing was uploaded.",
    "TiboTattle 无法读取本地审阅状态。请选择“再次检查”。未上传任何内容。",
    "TiboTattle no pudo leer el estado de revisión local. Elige Comprobar de nuevo. No se cargó nada.",
  ],
  "contribution.diagnostics.copy": [
    "Copy diagnostics",
    "复制诊断信息",
    "Copiar diagnóstico",
  ],
  "contribution.diagnostics.copying": [
    "Copying…",
    "正在复制…",
    "Copiando…",
  ],
  "contribution.diagnostics.copied": [
    "Diagnostics copied",
    "诊断信息已复制",
    "Diagnóstico copiado",
  ],
  "contribution.diagnostics.failed": [
    "Could not copy diagnostics",
    "无法复制诊断信息",
    "No se pudo copiar el diagnóstico",
  ],
  "consent.syncProgress": [
    "Sync: {synced} of {total} days synced · {pending} pending.",
    "同步：{total} 天中已同步 {synced} 天 · 待同步 {pending} 天。",
    "Sincronización: {synced} de {total} días sincronizados · {pending} pendientes.",
  ],
  "consent.syncStarting": [
    "Sync: starting the first pass…",
    "同步：正在启动首次运行…",
    "Sincronización: iniciando la primera pasada…",
  ],
  "consent.syncUploading": [
    "Uploading day {current} of {total}…",
    "正在上传第 {current} 天（共 {total} 天）…",
    "Subiendo el día {current} de {total}…",
  ],
  "consent.syncRefreshingAuthority": [
    "Sync: refreshing this Mac's upload authorization…",
    "同步：正在刷新这台 Mac 的上传授权…",
    "Sincronización: actualizando la autorización de subida de este Mac…",
  ],
  "consent.repairRequired": [
    "Sharing is paused until this Mac is reconnected. Your history is preserved.",
    "共享已暂停，重新连接这台 Mac 后才能继续。您的历史记录已保留。",
    "La contribución está en pausa hasta que vuelvas a conectar este Mac. Tu historial se conserva.",
  ],
  "consent.repairConnection": ["Repair connection", "修复连接", "Reparar conexión"],
  "consent.repairIncomplete": [
    "This Mac's connection could not be confirmed. Sharing stays paused; try Repair connection again.",
    "无法确认这台 Mac 的连接。共享仍暂停，请再次尝试修复连接。",
    "No se pudo confirmar la conexión de este Mac. La contribución sigue en pausa; vuelve a elegir Reparar conexión.",
  ],
  "consent.reviewAndApprove": ["Review and approve", "审阅并核准", "Revisar y aprobar"],
  "consent.authorityRefreshed": [
    "This Mac's contribution authorization is refreshed. Uploads continue automatically.",
    "这台 Mac 的贡献授权已刷新。上传将自动继续。",
    "La autorización de contribución de este Mac se ha actualizado. Las subidas continúan automáticamente.",
  ],
  "consent.syncPaused": [
    "Paused: {reason}.",
    "已暂停：{reason}。",
    "En pausa: {reason}.",
  ],
  "consent.syncLastError": [
    "Last error: {code}.",
    "最近错误：{code}。",
    "Último error: {code}.",
  ],
  "consent.syncRetryFailed": [
    "The retry request failed: {code}.",
    "重试请求失败：{code}。",
    "La solicitud de reintento falló: {code}.",
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
  // The merged five-state identity status shown at the sign-in chip, and the
  // one next action beside it (owner-reported contradictory states,
  // 2026-08-08/10). New / Signing in… / Signed in / Reconnecting / Connected.
  "identity.state.new": ["New", "新", "Nuevo"],
  "identity.state.signingIn": ["Signing in…", "正在登录…", "Iniciando sesión…"],
  "identity.state.signedIn": ["Signed in", "已登录", "Sesión iniciada"],
  "identity.state.reconnecting": ["Reconnecting", "正在重新连接", "Reconectando"],
  "identity.state.connected": ["Connected", "已连接", "Conectado"],
  "identity.next.new": [
    "Sign in with Google or Apple to contribute.",
    "使用 Google 或 Apple 登录即可贡献。",
    "Inicia sesión con Google o Apple para contribuir.",
  ],
  "identity.next.signingIn": [
    "Finish in your browser; TiboTattle returns when it's ready.",
    "请在浏览器中完成；准备就绪后 TiboTattle 会自动返回。",
    "Termina en tu navegador; TiboTattle vuelve cuando esté listo.",
  ],
  "identity.next.signedIn": [
    "Review below, then approve to connect this Mac. Nothing uploads before approval.",
    "请在下方审阅并核准以连接这台 Mac。核准前不会上传任何内容。",
    "Revisa abajo y aprueba para conectar este Mac. Nada se sube antes de aprobar.",
  ],
  "identity.next.reconnecting": [
    "Reconnecting this Mac automatically. Nothing was uploaded.",
    "正在自动重新连接这台 Mac。未上传任何内容。",
    "Reconectando este Mac automáticamente. No se cargó nada.",
  ],
  "identity.next.reconnectSignIn": [
    "Sign in again to finish connecting this Mac.",
    "请重新登录以完成这台 Mac 的连接。",
    "Inicia sesión de nuevo para terminar de conectar este Mac.",
  ],
  "identity.next.connected": [
    "This Mac is contributing.",
    "这台 Mac 正在贡献。",
    "Este Mac está contribuyendo.",
  ],
  "title.panCalibrationEarlier": ["Pan calibration earlier", "向前平移校准", "Desplazar la calibración hacia antes"],
  "title.zoomOut": ["Zoom out", "缩小", "Alejar"],
  "title.zoomIn": ["Zoom in", "放大", "Acercar"],
  "title.panCalibrationLater": ["Pan calibration later", "向后平移校准", "Desplazar la calibración hacia después"],
  "title.panUsageEarlier": ["Pan usage earlier", "向前平移使用情况", "Desplazar el uso hacia antes"],
  "title.panUsageLater": ["Pan usage later", "向后平移使用情况", "Desplazar el uso hacia después"],
  "installer.headerDownload": ["Get the app", "获取应用", "Obtener la app"],
  "installer.installDesktop": ["Install the desktop app", "安装桌面应用", "Instala la app de escritorio"],
  "installer.choosePlatform": ["Choose your platform", "选择你的平台", "Elige tu plataforma"],
  "installer.platform.macos": ["macOS", "macOS", "macOS"],
  "installer.platform.windows": ["Windows", "Windows", "Windows"],
  "installer.platform.linux": ["Linux", "Linux", "Linux"],
  "installer.availability.notYetAvailable": ["Not yet available", "尚未提供", "Aún no disponible"],
  "installer.windows.unavailableTitle": ["TiboTattle for Windows is not available yet.", "Windows 版 TiboTattle 尚未提供。", "TiboTattle para Windows aún no está disponible."],
  "installer.windows.unavailableCopy": ["Follow the Windows support work for progress. A download will appear only after the Windows release passes its platform and release checks.", "关注 Windows 支持工作的进展。只有在 Windows 版本通过平台和发行检查后，才会提供下载。", "Sigue el trabajo de compatibilidad con Windows para ver los avances. La descarga solo aparecerá cuando la versión para Windows supere las comprobaciones de plataforma y lanzamiento."],
  "installer.windows.trackSupport": ["Track Windows support", "关注 Windows 支持", "Seguir la compatibilidad con Windows"],
  "installer.linux.unavailableTitle": ["TiboTattle for Linux is not available yet.", "Linux 版 TiboTattle 尚未提供。", "TiboTattle para Linux aún no está disponible."],
  "installer.linux.unavailableCopy": ["Follow the Linux support work for progress. A download will appear only after the Linux release passes its platform and release checks.", "关注 Linux 支持工作的进展。只有在 Linux 版本通过平台和发行检查后，才会提供下载。", "Sigue el trabajo de compatibilidad con Linux para ver los avances. La descarga solo aparecerá cuando la versión para Linux supere las comprobaciones de plataforma y lanzamiento."],
  "installer.linux.trackSupport": ["Track Linux support", "关注 Linux 支持", "Seguir la compatibilidad con Linux"],
  "installer.version": ["Version {version}", "版本 {version}", "Versión {version}"],
  "installer.requiresMacOS": ["Requires macOS {version} or later · {architecture}", "需要 macOS {version} 或更高版本 · {architecture}", "Requiere macOS {version} o posterior · {architecture}"],
  "installer.compatibilitySummary": ["macOS {version} or later · {architecture}", "macOS {version} 或更高版本 · {architecture}", "macOS {version} o posterior · {architecture}"],
  "installer.downloadKiB": ["{value} KiB download", "下载 {value} KiB", "Descarga de {value} KiB"],
  "installer.downloadMiB": ["{value} MiB download", "下载 {value} MiB", "Descarga de {value} MiB"],
  "installer.sha256": ["SHA-256 {value}", "SHA-256 {value}", "SHA-256 {value}"],
  "installer.sha256.copy": ["Copy SHA-256", "复制 SHA-256", "Copiar SHA-256"],
  "installer.sha256.copied": ["SHA-256 copied", "SHA-256 已复制", "SHA-256 copiado"],
  "installer.sha256.copySuccess": ["SHA-256 checksum copied.", "SHA-256 校验和已复制。", "Se copió la suma de comprobación SHA-256."],
  "installer.sha256.copyFailure": ["Automatic copy was blocked. Select the displayed SHA-256 checksum to copy it manually.", "自动复制被阻止。请选择显示的 SHA-256 校验和以手动复制。", "Se bloqueó la copia automática. Selecciona la suma de comprobación SHA-256 mostrada para copiarla manualmente."],
  "installer.appleSilicon": ["Apple silicon", "Apple 芯片", "Apple Silicon"],
  "installer.intel": ["Intel", "Intel", "Intel"],
  "installer.appleSiliconAndIntel": ["Apple silicon and Intel", "Apple 芯片和 Intel", "Apple Silicon e Intel"],
  "installer.homebrew.copy": ["Copy", "复制", "Copiar"],
  "installer.homebrew.copied": ["Copied", "已复制", "Copiado"],
  "installer.homebrew.copyManually": ["Copy manually", "手动复制", "Copiar manualmente"],
  "installer.homebrew.copySuccess": ["Homebrew install command copied.", "已复制 Homebrew 安装命令。", "Comando de instalación de Homebrew copiado."],
  "installer.homebrew.copyFailure": ["Automatic copy was blocked. The command is selected; copy it manually.", "自动复制被阻止。命令已选中；请手动复制。", "La copia automática fue bloqueada. El comando está seleccionado; cópialo manualmente."],
  "installer.assurance.message": ["Developer ID signed and Apple notarized.", "Developer ID 签名并通过 Apple 公证。", "Firmada con Developer ID y notarizada por Apple."],
  "installer.assurance.details": ["Security and verification", "安全与验证", "Seguridad y verificación"],
  "community.daily.title": ["Community daily activity", "社区每日活动", "Actividad comunitaria diaria"],
  "community.reportedCause": ["Reported cause: {code}.", "报告原因：{code}。", "Causa informada: {code}."],
  "community.serviceReference": ["Service reference {reference}.", "服务参考：{reference}。", "Referencia del servicio {reference}."],
  "community.released": ["Released", "已发布", "Publicado"],
  "community.metric.usageEvents": ["Usage events", "使用事件", "Eventos de uso"],
  "community.metric.combinedOutput": ["Output tokens", "输出 token", "Tokens de salida"],
  "community.daily.state.serviceUnavailable": ["Daily community activity is temporarily unavailable. This does not tell us whether any day has been published.", "每日社区活动暂时不可用。这并不能说明是否已发布任何日期。", "La actividad comunitaria diaria no está disponible temporalmente. Esto no indica si se ha publicado algún día."],
  "community.daily.state.unsupportedSchema": ["The daily community series cannot be displayed safely with this version of TiboTattle.", "此版本的 TiboTattle 无法安全显示每日社区序列。", "La serie comunitaria diaria no se puede mostrar de forma segura con esta versión de TiboTattle."],
  "community.daily.state.nonePublished": ["No daily community activity has been published for the year window yet.", "此一年窗口内尚未发布任何每日社区活动。", "Todavía no se ha publicado actividad comunitaria diaria para la ventana anual."],
  "community.daily.seriesAvailable": ["Daily series available", "每日序列可用", "Serie diaria disponible"],
  "community.daily.seriesUnavailable": ["Daily series unavailable", "每日序列不可用", "Serie diaria no disponible"],
  "community.daily.noneYet": ["No daily activity published yet", "尚未发布每日活动", "Aún no se ha publicado actividad diaria"],
  "community.daily.failedLoad": ["The daily community series could not be loaded. Nothing is inferred from a failed request.", "无法加载每日社区序列。失败的请求不会推断任何结果。", "No se pudo cargar la serie comunitaria diaria. No se infiere nada de una solicitud fallida."],
  "community.daily.activitySummary": ["See community activity", "查看社区活动", "Ver la actividad de la comunidad"],
  "community.daily.activityHeading": ["Community activity over time", "社区活动趋势", "Actividad de la comunidad a lo largo del tiempo"],
  "community.daily.activityCopy": ["Delayed, aggregate daily totals from optional contributions. This public view includes no prompts, responses, or account details.", "来自可选贡献的延迟汇总每日总量。此公开视图不包含提示词、回复或账户详情。", "Totales diarios agregados y diferidos de contribuciones opcionales. Esta vista pública no incluye prompts, respuestas ni datos de cuentas."],
  "community.daily.activityThrough": ["Activity through", "活动截至", "Actividad hasta"],
  "community.daily.activityThroughDetail": ["Most recent community day", "最近的社区活动日期", "Día más reciente de la comunidad"],
  "community.daily.contributorsThatDay": ["Contributors that day", "当日贡献账户", "Colaboradores ese día"],
  "community.daily.contributorsThatDayDetail": ["Accounts represented on that day", "该日涵盖的账户", "Cuentas representadas ese día"],
  "community.daily.turnsCounted": ["Turns counted", "已计入的轮次", "Turnos contabilizados"],
  "community.daily.turnsCountedDetail": ["Usage events across {days} shared days", "跨 {days} 个共享日期的使用事件", "Eventos de uso en {days} días compartidos"],
  "community.daily.outputTokensCounted": ["Output tokens counted", "已计入的输出 token", "Tokens de salida contabilizados"],
  "community.daily.outputTokensCountedDetail": ["Combined output across {days} shared days", "跨 {days} 个共享日期的合并输出", "Salida combinada en {days} días compartidos"],
  "community.daily.latestDay": ["Latest published day", "最新发布日期", "Último día publicado"],
  "community.daily.revision": ["Revision", "修订", "Revisión"],
  "community.daily.revisionAge": ["Revision age", "修订时长", "Antigüedad de la revisión"],
  "community.daily.publishedDays": ["Published days in window", "窗口内已发布天数", "Días publicados en la ventana"],
  "community.daily.recomputeNote": ["Late contributions can update a day; this view always shows the newest published totals.", "迟到的贡献可能会更新某一天；此视图始终显示最新发布的总量。", "Las contribuciones tardías pueden actualizar un día; esta vista siempre muestra los totales publicados más recientes."],
  "community.daily.chartLabel": ["Daily community activity chart", "每日社区活动图表", "Gráfico de actividad comunitaria diaria"],
  "community.daily.chartDescription": ["Usage events per published day as bars, with combined output tokens as a line on a second axis. Unpublished days appear as gaps.", "每个已发布日期的使用事件以柱形显示，合并输出令牌以第二坐标轴上的折线显示。未发布的日期显示为空缺。", "Los eventos de uso por día publicado se muestran como barras, y los tokens de salida combinada como una línea en un segundo eje. Los días sin publicar aparecen como huecos."],
  "community.daily.seriesFilling": ["The daily series is still filling in. Dots mark the few published days so far.", "每日序列仍在补充中。圆点标记目前已发布的少量日期。", "La serie diaria todavía se está completando. Los puntos marcan los pocos días publicados hasta ahora."],
  "community.daily.detailedDays": ["View the daily series ({count} days)", "查看每日序列（{count} 天）", "Ver la serie diaria ({count} días)"],
  "community.daily.metricsCaption": ["Delayed daily community activity totals", "延迟的每日社区活动总量", "Totales diferidos de actividad comunitaria diaria"],
  "community.daily.day": ["Day", "日期", "Día"],
  "community.daily.quotaObservations": ["Quota observations", "额度观测", "Observaciones de cuota"],
  "community.daily.contributingDevices": ["Contributing devices", "贡献设备", "Dispositivos contribuyentes"],
  // The community allowance series. Aggregate dollar-equivalent estimates and
  // participant counts are owner-approved for publication; the participant
  // count is part of the claim and always rendered as visible copy.
  "community.title": ["What the Codex allowance is really worth", "Codex 额度到底值多少", "Cuánto vale realmente la asignación de Codex"],
  "community.hero.context": ["Community view", "社区视图", "Vista de la comunidad"],
  "community.allowance.heading": ["Combined Pro 20x-equivalent allowance", "合并后的 Pro 20x 等值额度", "Asignación combinada equivalente a Pro 20x"],
  "community.allowance.heroCopy": ["One combined estimate across contributing personal-plan accounts, normalized to a Pro 20x equivalent and valued at API prices.", "一个合并估计，涵盖参与贡献的个人方案账户，统一换算为 Pro 20x 等值并按 API 价格计值。", "Una sola estimación combinada de las cuentas contribuyentes de planes personales, normalizada a un equivalente de Pro 20x y valorada a precios de API."],
  "community.allowance.dialogEyebrow": ["Community view", "社区视图", "Vista de la comunidad"],
  "community.allowance.dialogTitle": ["Explore community allowance history", "探索社区额度历史", "Explora el historial de asignación comunitaria"],
  "community.allowance.dialogCopy": ["A larger view of the same published estimate. Hover, tap, or use the arrow keys to inspect a day.", "同一已发布估计的放大视图。悬停、轻点或使用方向键查看某一天。", "Una vista ampliada de la misma estimación publicada. Pasa el cursor, toca o usa las flechas para examinar un día."],
  "community.allowance.dialogRange": ["Time range", "时间范围", "Intervalo de tiempo"],
  "community.allowance.dialogClose": ["Close", "关闭", "Cerrar"],
  "community.allowance.state.serviceUnavailable": ["The community allowance series is temporarily unavailable. This does not tell us whether any estimate has been published.", "社区额度序列暂时不可用。这并不能说明是否已发布任何估计。", "La serie comunitaria de asignación no está disponible temporalmente. Esto no indica si se ha publicado alguna estimación."],
  "community.allowance.state.unsupportedSchema": ["The community allowance series cannot be displayed safely with this version of TiboTattle.", "此版本的 TiboTattle 无法安全显示社区额度序列。", "La serie comunitaria de asignación no se puede mostrar de forma segura con esta versión de TiboTattle."],
  "community.allowance.state.nonePublished": ["No community days have been published for the year window yet.", "此一年窗口内尚未发布任何社区日期。", "Todavía no se ha publicado ningún día comunitario para la ventana anual."],
  "community.allowance.available": ["Allowance estimates available", "额度估计可用", "Estimaciones de asignación disponibles"],
  "community.allowance.unavailable": ["Allowance estimates unavailable", "额度估计不可用", "Estimaciones de asignación no disponibles"],
  "community.allowance.accumulating": ["Estimates still accumulating", "估计仍在累积中", "Las estimaciones aún se están acumulando"],
  "community.allowance.updating": ["Merged history updating", "合并历史正在更新", "Actualizando el historial combinado"],
  "community.allowance.updatingCopy": ["The merged allowance history is updating. Daily activity remains available below.", "合并后的额度历史正在更新。下方的每日活动仍然可用。", "El historial combinado de asignación se está actualizando. La actividad diaria sigue disponible más abajo."],
  "community.allowance.stillAccumulating": ["Allowance estimates are still accumulating. Published days exist, but no reset fit has qualified yet — the daily activity below shows contributions arriving.", "额度估计仍在累积中。已有发布的日期，但尚无合格的重置拟合——下方的每日活动显示贡献正在到达。", "Las estimaciones de asignación aún se están acumulando. Existen días publicados, pero ningún ajuste de restablecimiento ha calificado todavía; la actividad diaria más abajo muestra que las contribuciones están llegando."],
  "community.allowance.noneInRange": ["No allowance estimates fall inside this range. Select All to see every published estimate.", "此范围内没有额度估计。选择“全部”以查看所有已发布的估计。", "Ninguna estimación de asignación cae dentro de este intervalo. Selecciona Todo para ver todas las estimaciones publicadas."],
  "community.allowance.perWindow": ["per 7 days, API-price equivalent", "每 7 天，API 价格等价值", "por 7 días, equivalente al precio de API"],
  "community.allowance.bandSentence": ["Plausible range {lower}–{upper} (middle 80% of reset fits).", "合理范围 {lower}–{upper}（重置拟合的中间 80%）。", "Rango plausible {lower}–{upper} (80 % central de los ajustes de restablecimiento)."],
  "community.allowance.latestLabel": ["Latest published estimate ({day}):", "最新发布的估计（{day}）：", "Última estimación publicada ({day}):"],
  // Composition template so each locale keeps its own punctuation between the
  // latest-label, account-count, and fit-count fragments.
  "community.allowance.caveatSentence": ["{latest} {accounts}, {fits}.", "{latest}{accounts}，{fits}。", "{latest} {accounts}, {fits}."],
  "community.allowance.legendCentral": ["Central estimate (median of reset fits)", "中心估计（重置拟合的中位数）", "Estimación central (mediana de los ajustes de restablecimiento)"],
  "community.allowance.legendBand": ["Plausible range (middle 80%)", "合理范围（中间 80%）", "Rango plausible (80 % central)"],
  "community.allowance.legendDots": ["Dot size = reset fits behind the day", "圆点大小 = 该日背后的重置拟合数", "Tamaño del punto = ajustes de restablecimiento detrás del día"],
  "community.allowance.chartLabel": ["Community allowance estimate chart", "社区额度估计图表", "Gráfico de estimación de asignación comunitaria"],
  "community.allowance.chartDescription": ["Combined Pro 20x-equivalent seven-day allowance value in API-equivalent dollars per published day: a central line, a shaded middle-80% range where published, and dots sized by the number of qualifying reset fits. Days without estimates appear as gaps.", "每个已发布日期的合并 Pro 20x 等值七天额度价值（API 等价美元）：一条中心线、发布时的中间 80% 阴影范围，以及按合格重置拟合数量确定大小的圆点。没有估计的日期显示为空缺。", "Valor combinado equivalente a Pro 20x de la asignación de siete días en dólares equivalentes de API por día publicado: una línea central, un rango sombreado del 80 % central donde se publicó y puntos cuyo tamaño refleja el número de ajustes de restablecimiento válidos. Los días sin estimaciones aparecen como huecos."],
  "community.allowance.sparseNote": ["The allowance series is still filling in. Dots mark the few published estimates so far.", "额度序列仍在补充中。圆点标记目前已发布的少量估计。", "La serie de asignación todavía se está completando. Los puntos marcan las pocas estimaciones publicadas hasta ahora."],
  // Compact strings for the on-chart hover tooltip: a small caption under the
  // central dollar value, and a single-line plausible-range row (the legend and
  // headline carry the full-sentence forms).
  "community.allowance.tooltipCentralCaption": ["central estimate", "中心估计", "estimación central"],
  "community.allowance.tooltipRange": ["Plausible range {lower}–{upper}", "合理范围 {lower}–{upper}", "Rango plausible {lower}–{upper}"],
  "community.allowance.methodNote": ["Each point combines qualifying reset fits from the trailing 30 days after normalizing supported personal plans to a Pro 20x equivalent (Pro ×1, Pro 5x ×4, Plus ×20). The line is the median, the range is the middle 80%, and every fit passes the shared calibration gates including the 40-point observed-span floor. Unsupported plans are excluded; late data republishes the day.", "每个点都汇总过去 30 天内的合格重置拟合，并将支持的个人方案换算为 Pro 20x 等值（Pro ×1、Pro 5x ×4、Plus ×20）。折线为中位数，区间为中间 80%；每个拟合均通过共享校准门槛，包括 40 个百分点的观测跨度下限。不支持的方案会被排除；迟到的数据会重新发布对应日期。", "Cada punto combina los ajustes de restablecimiento válidos de los últimos 30 días tras normalizar los planes personales compatibles a un equivalente de Pro 20x (Pro ×1, Pro 5x ×4 y Plus ×20). La línea es la mediana, el rango es el 80 % central y cada ajuste supera las puertas de calibración compartidas, incluido el mínimo de 40 puntos de amplitud observada. Los planes no compatibles se excluyen; los datos tardíos vuelven a publicar el día."],
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
  "format.rolloutSourceCount": Object.freeze({
    one: ["{count} rollout source", "{count} 个 rollout 来源", "{count} fuente rollout"],
    other: ["{count} rollout sources", "{count} 个 rollout 来源", "{count} fuentes rollout"],
  }),
  "format.affectedThreadCount": Object.freeze({
    one: ["{count} affected thread", "受影响的 {count} 个线程", "{count} hilo afectado"],
    other: ["{count} affected threads", "受影响的 {count} 个线程", "{count} hilos afectados"],
  }),
  "dashboard.history.partialNote": Object.freeze({
    one: ["The indexed totals remain usable. {count} affected thread did not pass local validation, so its missing usage remains unavailable rather than zero. You can check again after the local rollout files change.", "已索引的总计仍然可用。受影响的 {count} 个线程未通过本地验证，因此缺失用量保持为不可用，而不是零。本地 rollout 文件发生变化后可以再次检查。", "Los totales indexados siguen siendo utilizables. {count} hilo afectado no superó la validación local, por lo que su uso ausente permanece no disponible en lugar de mostrarse como cero. Puedes comprobarlo de nuevo cuando cambien los archivos rollout locales."],
    other: ["The indexed totals remain usable. {count} affected threads did not pass local validation, so their missing usage remains unavailable rather than zero. You can check again after the local rollout files change.", "已索引的总计仍然可用。受影响的 {count} 个线程未通过本地验证，因此缺失用量保持为不可用，而不是零。本地 rollout 文件发生变化后可以再次检查。", "Los totales indexados siguen siendo utilizables. {count} hilos afectados no superaron la validación local, por lo que su uso ausente permanece no disponible en lugar de mostrarse como cero. Puedes comprobarlo de nuevo cuando cambien los archivos rollout locales."],
  }),
  "accounting.sideChat.coverageRetentionLimit": Object.freeze({
    one: ["{count} retained side-chat partition reached the local 1,000-row retention limit, so earlier evidence in it may be missing.", "{count} 个保留的侧聊分区已达到本地 1,000 行保留上限，因此其中较早的证据可能缺失。", "{count} partición conservada alcanzó el límite local de 1.000 filas, por lo que puede faltar evidencia anterior."],
    other: ["{count} retained side-chat partitions reached the local 1,000-row retention limit, so earlier evidence in them may be missing.", "{count} 个保留的侧聊分区已达到本地 1,000 行保留上限，因此其中较早的证据可能缺失。", "{count} particiones conservadas alcanzaron el límite local de 1.000 filas, por lo que puede faltar evidencia anterior."],
  }),
  "accounting.sideChat.coverageDuplicates": Object.freeze({
    one: ["{count} repeated sampling marker was deduplicated.", "已去重 {count} 个重复采样标记。", "Se deduplicó {count} marcador de muestreo repetido."],
    other: ["{count} repeated sampling markers were deduplicated.", "已去重 {count} 个重复采样标记。", "Se deduplicaron {count} marcadores de muestreo repetidos."],
  }),
  "accounting.sideChat.detailsTruncated": Object.freeze({
    one: ["{count} retained call is outside the {limit}-row detail cap.", "有 {count} 个保留调用超出 {limit} 行详情上限。", "{count} llamada conservada queda fuera del límite de {limit} filas de detalle."],
    other: ["{count} retained calls are outside the {limit}-row detail cap.", "有 {count} 个保留调用超出 {limit} 行详情上限。", "{count} llamadas conservadas quedan fuera del límite de {limit} filas de detalle."],
  }),
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
  // One entry per exclusion mechanism the evidence classifier can actually
  // report, so the copy names the condition that fired instead of blaming
  // every excluded window on "missing or ambiguous" evidence at once.
  "dashboard.timeline.excludedQuotaWeighting": Object.freeze({
    one: ["{count} window is excluded because its speed-adjusted allowance weighting is unavailable", "有 {count} 个窗口因缺少速度调整后的额度权重而被排除", "{count} ventana está excluida porque no está disponible su ponderación de cuota ajustada por velocidad"],
    other: ["{count} windows are excluded because their speed-adjusted allowance weighting is unavailable", "有 {count} 个窗口因缺少速度调整后的额度权重而被排除", "{count} ventanas están excluidas porque no está disponible su ponderación de cuota ajustada por velocidad"],
  }),
  "dashboard.timeline.excludedMissingBracket": Object.freeze({
    one: ["{count} window is excluded because no quota reading covers its edges (collection gap)", "有 {count} 个窗口因边缘缺少额度读数（采集中断）而被排除", "{count} ventana está excluida porque ninguna lectura de cuota cubre sus bordes (pausa de recolección)"],
    other: ["{count} windows are excluded because no quota reading covers their edges (collection gap)", "有 {count} 个窗口因边缘缺少额度读数（采集中断）而被排除", "{count} ventanas están excluidas porque ninguna lectura de cuota cubre sus bordes (pausa de recolección)"],
  }),
  "dashboard.timeline.excludedResetOrTrackChange": Object.freeze({
    one: ["{count} window is excluded because it spans a quota reset or track change", "有 {count} 个窗口因跨越额度重置或轨道变化而被排除", "{count} ventana está excluida porque abarca un reinicio de cuota o cambio de pista"],
    other: ["{count} windows are excluded because they span a quota reset or track change", "有 {count} 个窗口因跨越额度重置或轨道变化而被排除", "{count} ventanas están excluidas porque abarcan un reinicio de cuota o cambio de pista"],
  }),
  "dashboard.timeline.excludedAmbiguousMovement": Object.freeze({
    one: ["{count} window is excluded because its quota movement is ambiguous", "有 {count} 个窗口因额度变化不明确而被排除", "{count} ventana está excluida porque su movimiento de cuota es ambiguo"],
    other: ["{count} windows are excluded because their quota movement is ambiguous", "有 {count} 个窗口因额度变化不明确而被排除", "{count} ventanas están excluidas porque su movimiento de cuota es ambiguo"],
  }),
  "dashboard.timeline.excludedPoolSaturated": Object.freeze({
    one: ["{count} window is suspended because the allowance was exhausted (display pegged at 100%)", "有 {count} 个窗口因额度已用尽（显示固定在 100%）而暂停", "{count} ventana está suspendida porque la asignación estaba agotada (indicador fijado en 100 %)"],
    other: ["{count} windows are suspended because the allowance was exhausted (display pegged at 100%)", "有 {count} 个窗口因额度已用尽（显示固定在 100%）而暂停", "{count} ventanas están suspendidas porque la asignación estaba agotada (indicador fijado en 100 %)"],
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
  "divergence.count": Object.freeze({
    one: ["{count} sustained divergence period in this range.", "此范围内有 {count} 个持续背离时段。", "{count} período de divergencia sostenida en este intervalo."],
    other: ["{count} sustained divergence periods in this range.", "此范围内有 {count} 个持续背离时段。", "{count} períodos de divergencia sostenida en este intervalo."],
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
  // The card's outlined marker, in words. A reader of the text transcript
  // cannot see the plot, so the difference the image draws has to be stated
  // rather than left to the picture.
  "share.text.shortObservation": Object.freeze({
    one: ["{count} of these is a short observation, drawn as an outlined marker.", "其中 {count} 个为短观测，以空心标记绘制。", "{count} de estos es una observación corta, dibujada como un marcador sin relleno."],
    other: ["{count} of these are short observations, drawn as outlined markers.", "其中 {count} 个为短观测，以空心标记绘制。", "{count} de estos son observaciones cortas, dibujadas como marcadores sin relleno."],
  }),
  // The community allowance caveat: the participant count backing every point
  // is visible copy, so "from 1 contributing account" reads plainly.
  "community.allowance.accountCount": Object.freeze({
    one: ["from {count} contributing account", "来自 {count} 个贡献账户", "de {count} cuenta contribuyente"],
    other: ["from {count} contributing accounts", "来自 {count} 个贡献账户", "de {count} cuentas contribuyentes"],
  }),
  "community.allowance.fitCount": Object.freeze({
    one: ["{count} qualifying reset fit in the trailing 30 days", "过去 30 天内 {count} 个合格重置拟合", "{count} ajuste de restablecimiento que califica en los últimos 30 días"],
    other: ["{count} qualifying reset fits in the trailing 30 days", "过去 30 天内 {count} 个合格重置拟合", "{count} ajustes de restablecimiento que califican en los últimos 30 días"],
  }),
  // The Allowance history chart's honest empty reason: fits exist in the
  // selected range, and the span floor filtered every one of them.
  "weekly.chart.emptyBelowFloor": Object.freeze({
    one: ["{count} fit is in range, below the {span}pp span floor.", "范围内有 {count} 个拟合，低于 {span}pp 跨度下限。", "{count} ajuste está en el intervalo, por debajo del umbral de {span}pp."],
    other: ["{count} fits are in range, all below the {span}pp span floor.", "范围内有 {count} 个拟合，全部低于 {span}pp 跨度下限。", "{count} ajustes están en el intervalo, todos por debajo del umbral de {span}pp."],
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
  // The single approve-once contribution flow (2026-08-08).
  "Contribute anonymous usage data": ["贡献匿名使用数据", "Contribuir datos de uso anónimos"],
  // One-step flow (owner-directed 2026-08-08): sign in, then approve once.
  "Help improve community estimates: sign in, then approve once. You see the covered data before anything is sent; after approval it stays current automatically.": [
    "帮助改进社区估计：登录后核准一次即可。发送任何内容之前你都会先看到所涵盖的数据；核准后它会自动保持最新。",
    "Ayuda a mejorar las estimaciones comunitarias: inicia sesión y aprueba una sola vez. Ves los datos cubiertos antes de que se envíe nada; tras la aprobación se mantienen al día automáticamente.",
  ],
  // Share panel caption (owner-directed 2026-08-08, third round): the header
  // above the card is title plus this ONE sentence — the filter promise and
  // the privacy promise together.
  "The card follows the chart’s active date range and span filter. It contains no prompts, responses, paths, account details, or raw activity.": [
    "卡片遵循图表当前生效的日期范围和跨度筛选。其中不含提示词、回复、路径、帐户详情或原始活动。",
    "La tarjeta sigue el intervalo de fechas activo y el filtro de span del gráfico. No contiene indicaciones, respuestas, rutas, detalles de cuenta ni actividad sin procesar.",
  ],
  // Allowance history: the honest error-bar naming (2026-08-08).
  "Slope-agreement range": ["斜率一致性区间", "Intervalo de concordancia de pendientes"],
  "Each reset estimate is drawn with its slope-agreement range: the spread of slopes from different pairs of observed quota boundaries within that reset. It is a within-reset disagreement diagnostic, not a confidence interval.": [
    "每个重置估计都带有其斜率一致性区间：由该重置内观测到的不同额度边界配对形成的斜率分布。它是重置内部的一致性诊断，而不是置信区间。",
    "Cada estimación de restablecimiento se dibuja con su intervalo de concordancia de pendientes: la dispersión de pendientes de distintos pares de límites de cuota observados dentro de ese restablecimiento. Es un diagnóstico de discrepancia interna, no un intervalo de confianza.",
  ],
  // The community guided journey: stage names, the collapsed review card, and
  // the approve-once incremental consent surface.
  "Local usage index": ["本地使用索引", "Índice de uso local"],
  "Sign in & approve": ["登录并核准", "Iniciar sesión y aprobar"],
  "This summary is the review": ["这份摘要就是审阅", "Este resumen es la revisión"],
  "Check summary again": ["再次检查摘要", "Volver a comprobar el resumen"],
  "Send unlocks only after these exact figures are verified on this Mac. What you see summarized here is exactly what would be sent.": ["只有在这台 Mac 上校验完这些确切数字后，“发送”才会解锁。你在此看到的摘要内容正是将要发送的内容。", "Enviar se desbloquea solo después de que estas cifras exactas se verifiquen en este Mac. Lo que ves resumido aquí es exactamente lo que se enviaría."],
  "Approve once": ["一次核准", "Aprobar una vez"],
  "Automatic full-history contribution": ["自动贡献完整历史", "Contribución automática del historial completo"],
  "Not approved": ["未核准", "No aprobado"],
  "Approval covers the kind of data, once — after it, your full history uploads and stays current without per-batch review.": ["核准针对数据类型，只需一次——此后你的完整历史会上传并保持最新，无需逐批审阅。", "La aprobación cubre el tipo de datos, una sola vez; después, tu historial completo se carga y se mantiene al día sin revisión por lotes."],
  "Your full usage history uploads first; new events then upload roughly every 6 hours.": ["首先上传你的完整使用历史；此后新事件大约每 6 小时上传一次。", "Primero se carga tu historial de uso completo; luego los eventos nuevos se cargan aproximadamente cada 6 horas."],
  "Community estimates recompute when your data or corrections to it arrive, including for past months.": ["当你的数据或对它的更正到达时，社区估计会重新计算，包括过去的月份。", "Las estimaciones comunitarias se recalculan cuando llegan tus datos o correcciones, incluso para meses pasados."],
  "The exact kind of data covered": ["涵盖的数据类型明细", "El tipo exacto de datos cubiertos"],
  "Covered: token counts, model identifiers or keyed fingerprints, tier, surface and outcome categories, timestamps, quota percentages, tool-class counts per session, and stable pseudonymous session identifiers.": ["涵盖：令牌数量、模型标识符或密钥指纹、层级、界面与结果类别、时间戳、额度百分比、每个会话的工具类别计数，以及稳定的化名会话标识符。", "Cubierto: recuentos de tokens, identificadores de modelo o huellas con clave, categorías de nivel, superficie y resultado, marcas de tiempo, porcentajes de cuota, recuentos de clases de herramientas por sesión e identificadores de sesión seudónimos estables."],
  "Never covered: prompts, responses, file names, paths, commands, or any account identifier.": ["绝不涵盖：提示词、回复、文件名、路径、命令或任何帐户标识符。", "Nunca cubierto: indicaciones, respuestas, nombres de archivo, rutas, comandos ni ningún identificador de cuenta."],
  "Review and approve": ["审阅并核准", "Revisar y aprobar"],
  "Copy diagnostics": ["复制诊断信息", "Copiar diagnóstico"],
  "Retry now": ["立即重试", "Reintentar ahora"],
  "Approval is asked once. Only a change to the kind of data or the destination asks again.": ["核准只询问一次。只有数据类型或目的地发生变化时才会再次询问。", "La aprobación se pide una sola vez. Solo un cambio en el tipo de datos o el destino vuelve a preguntar."],
  "Minimum observed quota span": ["最低观测额度跨度", "Intervalo mínimo de cuota observado"],
  "50+ pp": ["50+ 个百分点", "50+ pp"],
  "Local time": ["本地时间", "Hora local"],
  "Thread name": ["会话名称", "Nombre de la conversación"],
  "Skip to monitoring dashboard": ["跳到监测仪表板", "Ir al panel de seguimiento"],
  "Connecting": ["正在连接", "Conectando"],
  "Analyze local usage": ["分析本地使用情况", "Analizar el uso local"],
  "Overview": ["概览", "Resumen"],
  "Allowance": ["额度", "Límite"],
  "Trends": ["趋势", "Tendencias"],
  // Dashboard nav label for the #accounting page (renamed from "How it works",
  // 2026-08-09). The "How it works" entry below stays for the community site's
  // product walkthrough, which is a different section that keeps that name.
  "Usage and costs": ["用量与成本", "Uso y costes"],
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
  "Get the app": ["获取应用", "Obtener la app"],
  "Install the desktop app": ["安装桌面应用", "Instala la app de escritorio"],
  "TiboTattle turns your seven-day Codex allowance into an API-price-equivalent estimate, shows how it changes over time, and calculates your personal dashboard locally on your computer.": ["TiboTattle 会将你的 Codex 七天额度转换为 API 价格等值估计，展示它如何随时间变化，并在你的电脑上本地计算个人仪表板。", "TiboTattle convierte tu asignación de Codex de siete días en una estimación equivalente al precio de API, muestra cómo cambia con el tiempo y calcula tu panel personal localmente en tu ordenador."],
  "Choose TiboTattle for your platform": ["选择适合你平台的 TiboTattle", "Elige TiboTattle para tu plataforma"],
  "Choose your platform": ["选择你的平台", "Elige tu plataforma"],
  "macOS": ["macOS", "macOS"],
  "Windows": ["Windows", "Windows"],
  "Linux": ["Linux", "Linux"],
  "Not yet available": ["尚未提供", "Aún no disponible"],
  "TiboTattle for Windows is not available yet.": ["Windows 版 TiboTattle 尚未提供。", "TiboTattle para Windows aún no está disponible."],
  "Windows is not yet available": ["Windows 尚未提供", "Windows aún no está disponible"],
  "There is no published Windows build yet.": ["尚未发布 Windows 版本。", "Todavía no hay una versión publicada para Windows."],
  "Follow the Windows support work for progress. A download will appear only after the Windows release passes its platform and release checks.": ["关注 Windows 支持工作的进展。只有在 Windows 版本通过平台和发行检查后，才会提供下载。", "Sigue el trabajo de compatibilidad con Windows para ver los avances. La descarga solo aparecerá cuando la versión para Windows supere las comprobaciones de plataforma y lanzamiento."],
  "Track Windows support": ["关注 Windows 支持", "Seguir la compatibilidad con Windows"],
  "TiboTattle for Linux is not available yet.": ["Linux 版 TiboTattle 尚未提供。", "TiboTattle para Linux aún no está disponible."],
  "Linux is not yet available": ["Linux 尚未提供", "Linux aún no está disponible"],
  "There is no published Linux build yet.": ["尚未发布 Linux 版本。", "Todavía no hay una versión publicada para Linux."],
  "Follow the Linux support work for progress. A download will appear only after the Linux release passes its platform and release checks.": ["关注 Linux 支持工作的进展。只有在 Linux 版本通过平台和发行检查后，才会提供下载。", "Sigue el trabajo de compatibilidad con Linux para ver los avances. La descarga solo aparecerá cuando la versión para Linux supere las comprobaciones de plataforma y lanzamiento."],
  "Track Linux support": ["关注 Linux 支持", "Seguir la compatibilidad con Linux"],
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
  "Historical test case": ["历史测试案例", "Caso de prueba histórico"],
  "Historical quota-gap backcast": ["历史额度缺口回推", "Retrocálculo histórico de la brecha de cuota"],
  "View this day on the timeline": ["在时间线中查看这一天", "Ver este día en la cronología"],
  "Retained numeric estimate": ["保留的数值估算", "Estimación numérica conservada"],
  "Local usage over time": ["本地使用情况随时间变化", "Uso local a lo largo del tiempo"],
  "Observed allowance remaining": ["观测到的剩余额度", "Cuota restante observada"],
  "Window boundary or track change": ["窗口边界或额度轨道变化", "Límite de ventana o cambio de seguimiento"],
  // Same wording as `chart.status.quotaWeightingUnavailable` above, reused
  // verbatim: the legend swatch and the band's own tooltip name one mechanism,
  // so they must not drift into two different phrasings per locale.
  "Speed pricing unavailable": ["按速度档定价不可用", "Ponderación por cuota no disponible"],
  "Movement needs context": ["变化需要上下文", "El movimiento necesita contexto"],
  "Allowance exhausted": ["额度已用尽", "Asignación agotada"],
  "Per-model rates": ["各模型费率", "Tasas por modelo"],
  "Each model consumes the weekly allowance at its own rate, so the headline blends these over your recent mix.": ["每个模型以各自的速率消耗每周额度，因此标题按你近期的模型组合对这些费率加权混合。", "Cada modelo consume la asignación semanal a su propia tasa, así que el titular las combina según tu mezcla reciente."],
  "Indexed history": ["已索引历史", "Historial indexado"],
  "Model usage": ["模型使用情况", "Uso por modelo"],
  "A model on a separate allowance is listed on its own row and carries no API equivalent, because that figure cannot be compared with the main allowance. Nothing unavailable is replaced with an invented cost.": ["使用独立额度的模型会单独列为一行，并且不显示 API 等价值，因为该数值无法与主额度比较。任何不可用的数据都不会被虚构成本替代。", "Un modelo con una cuota independiente aparece en su propia fila y no lleva equivalente de API, porque esa cifra no se puede comparar con la cuota principal. Nada que no esté disponible se sustituye por un coste inventado."],
  "Replay-safe usage grouped by model, across every allowance. Each model expands into its token components as rows of the same table.": ["按模型分组的可安全重放使用情况，涵盖所有额度。每个模型可展开为同一表格中的令牌组成行。", "Uso seguro para reproducción agrupado por modelo, en todas las cuotas. Cada modelo se expande en sus componentes de tokens como filas de la misma tabla."],
  "Review before sending": ["发送前审阅", "Revisar antes de enviar"],
  "Prepare and review a contribution": ["准备并审阅贡献", "Preparar y revisar una contribución"],
  "Nothing sends automatically": ["不会自动发送任何内容", "Nada se envía automáticamente"],
  "Dashboard contract: waiting": ["仪表板契约：等待中", "Contrato del panel: en espera"],
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
  "Uploads are paused because TiboTattle could not access this Mac's upload credential. The existing credential and local history are unchanged. Nothing was uploaded. You can try again later.": ["TiboTattle 无法访问这台 Mac 的上传凭据，因此上传已暂停。现有凭据和本地历史记录均未改变。没有上传任何内容。你可以稍后重试。", "Las cargas están en pausa porque TiboTattle no pudo acceder a la credencial de carga de este Mac. La credencial existente y el historial local no han cambiado. No se ha subido nada. Puedes volver a intentarlo más tarde."],
  "Your existing local identity and history are unchanged. In TiboTattle, open Settings… → General and choose Review migration… under Secure upgrade when you’re ready. No upload occurred. Do not reset, delete, or rotate the identity.": ["现有本地身份和历史记录均未改变。你可以在方便时，在 TiboTattle 中打开“设置…”→“通用”，然后在“安全升级”下选择“查看迁移…”。没有上传任何内容。请勿重置、删除或更换该身份。", "Tu identidad local y tu historial existentes no han cambiado. Cuando quieras, abre Configuración… → General en TiboTattle y elige Revisar migración… en Actualización segura. No se ha subido nada. No restablezcas, elimines ni cambies la identidad."],
  "This Mac's existing upload credential and local history are unchanged. In TiboTattle, open Settings… → General and choose Review migration… under Secure upgrade when you’re ready. Nothing was uploaded. Do not reset or delete the credential.": ["这台 Mac 的现有上传凭据和本地历史记录均未改变。你可以在方便时，在 TiboTattle 中打开“设置…”→“通用”，然后在“安全升级”下选择“查看迁移…”。没有上传任何内容。请勿重置或删除该凭据。", "La credencial de carga y el historial local existentes de este Mac no han cambiado. Cuando quieras, abre Configuración… → General en TiboTattle y elige Revisar migración… en Actualización segura. No se ha subido nada. No restablezcas ni elimines la credencial."],
  "Resetting clears only that unusable credential and its local record. Then choose Review and approve again. If the reset fails too, quit and reopen TiboTattle first.": ["重置只会清除那条无法使用的凭据及其本地记录。然后请再次选择“查看并批准”。如果重置也失败，请先退出并重新打开 TiboTattle。", "Restablecer borra solo esa credencial inutilizable y su registro local. Después elige Revisar y aprobar de nuevo. Si el restablecimiento también falla, cierra y vuelve a abrir TiboTattle primero."],
  // The locked-keychain pause. Kept apart from the reset guidance above on
  // purpose: nothing is broken, so neither sentence may suggest clearing or
  // re-approving anything.
  "Uploads are paused: your Mac's login keychain is locked.": ["上传已暂停：这台 Mac 的登录钥匙串已锁定。", "Las cargas están en pausa: el llavero de inicio de sesión de tu Mac está bloqueado."],
  "Unlocking restores uploads by itself — there is nothing to reset and nothing to approve again. Anything not yet sent stays queued on this Mac.": ["解锁后上传会自行恢复——无需重置，也无需重新批准。尚未发送的内容会继续在这台 Mac 上排队等待。", "Desbloquearlo restaura las cargas por sí solo: no hay nada que restablecer ni que volver a aprobar. Lo que aún no se ha enviado permanece en cola en este Mac."],
  "Connecting stores this Mac's upload credential in your login keychain. Local reporting and history are unchanged.": ["连接会把这台 Mac 的上传凭据保存到你的登录钥匙串。本地报告和历史记录保持不变。", "Conectar guarda la credencial de carga de este Mac en tu llavero de inicio de sesión. Los informes y el historial locales no cambian."],
  "This Mac has an upload credential from an older build. TiboTattle first tries to move it to app-owned Keychain storage silently, without changing its value or uploading anything. If Secure upgrade appears in Settings, open Settings… → General and choose Review migration… when you’re ready. The existing credential and local history stay unchanged until migration finishes.": ["这台 Mac 有一个来自旧版本的上传凭据。TiboTattle 会先尝试在不更改其值或上传任何内容的情况下，将它静默迁移到应用自有的钥匙串存储中。如果“设置”中出现“安全升级”，请打开“设置…”→“通用”，并在方便时选择“查看迁移…”。在迁移完成前，现有凭据和本地历史记录保持不变。", "Este Mac tiene una credencial de carga de una versión anterior. TiboTattle primero intenta trasladarla silenciosamente al almacenamiento del llavero propio de la app, sin cambiar su valor ni subir nada. Si aparece Actualización segura en Configuración, abre Configuración… → General y elige Revisar migración… cuando quieras. La credencial y el historial local existentes no cambian hasta que finalice la migración."],
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
  "What the Codex allowance is really worth.": ["Codex 额度到底值多少。", "Cuánto vale realmente la asignación de Codex."],
  "TiboTattle turns your seven-day Codex allowance into an API-price-equivalent estimate, shows how it changes over time, and calculates your personal dashboard on your Mac.": ["TiboTattle 将你的七天 Codex 额度换算为 API 价格等价估计，展示它如何随时间变化，并在你的 Mac 上计算个人仪表板。", "TiboTattle convierte tu asignación de Codex de siete días en una estimación equivalente al precio de API, muestra cómo cambia con el tiempo y calcula tu panel personal en tu Mac."],
  "Copy SHA-256": ["复制 SHA-256", "Copiar SHA-256"],
  "Copy": ["复制", "Copiar"],
  "TiboTattle is a private Mac app that estimates how much of your seven-day Codex allowance remains and shows how your usage changes over time. Your personal dashboard is calculated on your Mac.": ["TiboTattle 是一款私密的 Mac 应用，可估算你的 Codex 七天额度还剩多少，并展示使用情况随时间的变化。你的个人仪表板会在 Mac 上计算。", "TiboTattle es una app privada para Mac que estima cuánto queda de tu límite de Codex de siete días y muestra cómo cambia tu uso con el tiempo. Tu panel personal se calcula en tu Mac."],
  "Public download coming soon.": ["公开下载即将推出。", "La descarga pública estará disponible pronto."],
  "Latest community evidence": ["最新社区证据", "Evidencia comunitaria más reciente"],
  "Install the Mac app": ["安装 Mac 应用", "Instala la app para Mac"],
  "Open TiboTattle and let it calculate your Codex usage locally.": ["打开 TiboTattle，让它在本地计算你的 Codex 使用情况。", "Abre TiboTattle y deja que calcule tu uso de Codex de forma local."],
  "See your week": ["查看你的一周", "Consulta tu semana"],
  "View your allowance estimate and history in the app.": ["在应用中查看额度估计和历史记录。", "Consulta en la app la estimación de tu límite y su historial."],
  "Share only if you choose": ["仅在你选择时分享", "Comparte solo si quieres"],
  "Review a content-free summary before any optional community contribution.": ["在选择向社区贡献之前，先查看不含内容的摘要。", "Revisa un resumen sin contenido antes de cualquier contribución opcional a la comunidad."],
  "When available, this leads with one combined Pro 20x-equivalent allowance from delayed, anonymous personal-plan contributions. The daily activity series sits below. A late contribution never edits history: it publishes a replacement revision for its day.": ["如有可用数据，这里会首先展示一个合并后的 Pro 20x 等值额度，数据来自延迟的匿名个人方案贡献。每日活动序列位于下方。迟到的贡献绝不会改写历史：它会为对应日期发布替代修订。", "Cuando está disponible, aquí se muestra primero una única asignación combinada equivalente a Pro 20x a partir de contribuciones anónimas y diferidas de planes personales. La serie de actividad diaria está debajo. Una contribución tardía nunca edita el historial: publica una revisión de reemplazo para su día."],
  "What the Codex allowance is really worth": ["Codex 额度到底值多少", "Cuánto vale realmente la asignación de Codex"],
  "Community view": ["社区视图", "Vista de la comunidad"],
  "See community activity": ["查看社区活动", "Ver la actividad de la comunidad"],
  "Community activity over time": ["社区活动趋势", "Actividad de la comunidad a lo largo del tiempo"],
  "Delayed, aggregate daily totals from optional contributions. This public view includes no prompts, responses, or account details.": ["来自可选贡献的延迟汇总每日总量。此公开视图不包含提示词、回复或账户详情。", "Totales diarios agregados y diferidos de contribuciones opcionales. Esta vista pública no incluye prompts, respuestas ni datos de cuentas."],
  "Explore community allowance history": ["探索社区额度历史", "Explora el historial de asignación comunitaria"],
  "A larger view of the same published estimate. Hover, tap, or use the arrow keys to inspect a day.": ["同一已发布估计的放大视图。悬停、轻点或使用方向键查看某一天。", "Una vista ampliada de la misma estimación publicada. Pasa el cursor, toca o usa las flechas para examinar un día."],
  "Close": ["关闭", "Cerrar"],
  "Time range": ["时间范围", "Intervalo de tiempo"],
  "Combined Pro 20x-equivalent allowance": ["合并后的 Pro 20x 等值额度", "Asignación combinada equivalente a Pro 20x"],
  "One combined estimate across contributing personal-plan accounts, normalized to a Pro 20x equivalent and valued at API prices.": ["一个合并估计，涵盖参与贡献的个人方案账户，统一换算为 Pro 20x 等值并按 API 价格计值。", "Una sola estimación combinada de las cuentas contribuyentes de planes personales, normalizada a un equivalente de Pro 20x y valorada a precios de API."],
  "Checking allowance estimates": ["正在检查额度估计", "Comprobando las estimaciones de asignación"],
  "Checking for published allowance estimates…": ["正在检查已发布的额度估计…", "Comprobando las estimaciones de asignación publicadas…"],
  "Checking daily activity": ["正在检查每日活动", "Comprobando la actividad diaria"],
  "Personal dashboards and contributions stay in the Mac app.": ["个人仪表板和贡献功能保留在 Mac 应用中。", "Los paneles personales y las contribuciones permanecen en la app para Mac."],
  "See community activity": ["查看社区活动", "Ver la actividad de la comunidad"],
  "Community activity over time": ["社区活动趋势", "Actividad de la comunidad a lo largo del tiempo"],
  "Delayed, aggregate daily totals from optional contributions. This public view includes no prompts, responses, or account details.": ["来自可选贡献的延迟汇总每日总量。此公开视图不包含提示词、回复或账户详情。", "Totales diarios agregados y diferidos de contribuciones opcionales. Esta vista pública no incluye prompts, respuestas ni datos de cuentas."],
  "See community activity details": ["查看社区活动详情", "Ver detalles de la actividad comunitaria"],
  "Explore community allowance history": ["探索社区额度历史", "Explora el historial de asignación comunitaria"],
  "A larger view of the same published estimate. Hover, tap, or use the arrow keys to inspect a day.": ["同一已发布估计的放大视图。悬停、轻点或使用方向键查看某一天。", "Una vista ampliada de la misma estimación publicada. Pasa el cursor, toca o usa las flechas para examinar un día."],
  "Time range": ["时间范围", "Intervalo de tiempo"],
  "Close": ["关闭", "Cerrar"],
  "Understand your Codex week.": ["了解你的 Codex 一周。", "Entiende tu semana de Codex."],
  "TiboTattle is a local-first Mac app for understanding personal Codex usage. It estimates your personal seven-day allowance in API-equivalent terms; the dashboard and its history stay on your Mac.": ["TiboTattle 是一款本地优先的 Mac 应用，用于了解个人 Codex 使用情况。它以 API 等价值估算你的个人七天额度；仪表板及其历史记录保留在你的 Mac 上。", "TiboTattle es una app para Mac que prioriza lo local y ayuda a entender tu uso personal de Codex. Estima tu límite personal de siete días en términos equivalentes de API; el panel y su historial permanecen en tu Mac."],
  "Download for macOS": ["下载 macOS 版", "Descargar para macOS"],
  "Developer ID signed and Apple notarized.": ["Developer ID 签名并通过 Apple 公证。", "Firmada con Developer ID y notarizada por Apple."],
  "Security and verification": ["安全与验证", "Seguridad y verificación"],
  "Or install with Homebrew": ["或使用 Homebrew 安装", "O instala con Homebrew"],
  "brew install --cask adamallcock/tap/tibotattle": ["brew install --cask adamallcock/tap/tibotattle", "brew install --cask adamallcock/tap/tibotattle"],
  "Already installed?": ["已经安装？", "¿Ya está instalada?"],
  "Open TiboTattle": ["打开 TiboTattle", "Abrir TiboTattle"],
  "Signed release coming soon.": ["已签名版本即将推出。", "Próximamente habrá una versión firmada."],
  "A download link appears only after a signed public installer and its release metadata pass the release checks. Otherwise, this release remains unavailable.": ["只有在已签名的公开安装程序及其发行元数据通过发行检查后，才会显示下载链接。否则，此版本仍不可用。", "El enlace de descarga solo aparece después de que un instalador público firmado y sus metadatos de versión superen las comprobaciones. De lo contrario, esta versión no está disponible."],
  "This website is read-only: it does not enroll contributors or accept uploads.": ["本网站是只读的：不会为贡献者注册账户或接受上传。", "Este sitio web es de solo lectura: no registra colaboradores ni acepta cargas."],
  "Delayed community activity": ["延迟的社区活动", "Actividad comunitaria diferida"],
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
  "Community activity": ["社区活动", "Actividad comunitaria"],
  "Shown as aggregate activity for the published period.": ["以已发布期间的汇总活动形式显示。", "Se muestra como actividad agregada del período publicado."],
  "Daily activity series": ["每日活动序列", "Serie de actividad diaria"],
  "Delayed daily totals for the past year. Each day shows its latest published revision.": ["过去一年的延迟每日总量。每一天都显示其最新发布的修订。", "Totales diarios diferidos del último año. Cada día muestra su última revisión publicada."],
  "Checking daily series": ["正在检查每日序列", "Comprobando la serie diaria"],
  "Checking for published daily activity…": ["正在检查已发布的每日活动…", "Comprobando la actividad diaria publicada…"],
  "Local-first and independent. Not affiliated with OpenAI.": ["本地优先且独立。与 OpenAI 无关。", "Local e independiente. Sin afiliación con OpenAI."],
  "GitHub": ["GitHub", "GitHub"],
  "X": ["X", "X"],
  "Turn on JavaScript to check download availability and the published daily community activity.": ["启用 JavaScript 以查看下载可用性和已发布的每日社区活动。", "Activa JavaScript para consultar la disponibilidad de descarga y la actividad comunitaria diaria publicada."],
  "Private usage visibility for Mac": ["面向 Mac 的私密使用情况可见性", "Visibilidad privada de uso para Mac"],
  "Know what your Codex week is doing.": ["了解你的 Codex 一周使用情况。", "Conoce qué está ocurriendo en tu semana de Codex."],
  "TiboTattle is a local-first Mac app that reads content-free usage and quota metadata on your Mac. Your personal dashboard stays in the app; this site only publishes delayed, aggregate activity that contributors chose to share.": ["TiboTattle 是一款本地优先的 Mac 应用，会在你的 Mac 上读取不含内容的使用情况和额度元数据。你的个人仪表板保留在应用内；本网站只发布贡献者选择分享的延迟汇总活动。", "TiboTattle es una app para Mac que prioriza lo local y lee metadatos de uso y cuota sin contenido en tu Mac. Tu panel personal permanece en la app; este sitio solo publica actividad agregada y diferida que los colaboradores eligieron compartir."],
  "A delayed activity snapshot, shared carefully.": ["谨慎分享的延迟活动快照。", "Un resumen de actividad diferida, compartido con cuidado."],
  "This page shows delayed, aggregate weekly activity from opt-in contributors — not your personal usage, reading, or cost.": ["本页展示自愿贡献者的延迟汇总每周活动，而不是你的个人使用情况、读数或成本。", "Esta página muestra actividad semanal agregada y diferida de colaboradores que aceptaron participar, no tu uso, lectura ni coste personal."],
  "A public community activity snapshot appears only when the service publishes one; this page does not derive one from activity totals.": ["只有服务发布公开社区活动快照时才会显示；本页不会根据活动总量推导快照。", "Un resumen público de actividad comunitaria solo aparece cuando el servicio publica uno; esta página no lo deriva de los totales de actividad."],
  "Community daily activity": ["社区每日活动", "Actividad comunitaria diaria"],
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
  "Speed-priced API-price equivalent": ["按按速度档定价的 API 价格等值", "Equivalente de precio de API con precio según velocidad"],
  "Replay-safe usage cost": ["可重放安全的使用成本", "Coste de uso seguro para reproducción"],
  "Standard-rate API prices applied to non-overlapping local token increments, then multiplied by the published Priority (Fast) API price ratio for increments whose effective mode is Fast. It tracks relative quota consumption; it is not a subscription charge or a published dollar limit.": ["将标准费率 API 价格应用于不重叠的本地令牌增量，再对有效模式为 Fast 的增量乘以公开的 Fast 抵扣费率。它跟踪相对额度消耗；不是订阅费用或公开的美元限额。", "Precios de API de tarifa estándar aplicados a incrementos locales de tokens no superpuestos y luego multiplicados por la tasa publicada de crédito Fast para incrementos cuyo modo efectivo es Fast. Registra el consumo relativo de cuota; no es un cargo de suscripción ni un límite en dólares publicado."],
  "Recorded period": ["记录期间", "Periodo registrado"],
  "This activity total can exceed the inferred weekly limit: it spans a calendar period, while the weekly estimate describes one observed reset track and may cross resets, credits, or account changes.": ["此活动总量可能超过推断的每周限额：它跨越一个日历期间，而每周估计描述的是一个观测到的重置轨迹，并且可能跨越重置、抵扣或帐户变化。", "Este total de actividad puede superar el límite semanal inferido: abarca un período de calendario, mientras que la estimación semanal describe una trayectoria de reinicio observada y puede cruzar reinicios, créditos o cambios de cuenta."],
  "Measured versus calculated": ["实测与计算", "Medido frente a calculado"],
  "Does token cost explain the quota change?": ["令牌成本能解释额度变化吗？", "¿El coste de tokens explica el cambio de cuota?"],
  "No evidence": ["无证据", "Sin evidencia"],
  "Observed quota movement": ["观测到的额度变化", "Movimiento de cuota observado"],
  "Cost-implied movement": ["成本推算的变化", "Movimiento implícito por el coste"],
  "More observations are required before a useful comparison can be made.": ["需要更多观测结果才能进行有意义的比较。", "Se requieren más observaciones antes de poder realizar una comparación útil."],
  "Central fitted rate · per point": ["中心拟合比率 · 每点", "Tasa central ajustada · por punto"],
  "Not estimable": ["无法估计", "No estimable"],
  "Plausible 80% range · per point": ["可信的 80% 范围 · 每点", "Rango plausible del 80 % · por punto"],
  "This fit uses API prices as a measuring stick. It is not a provider-published dollar allowance.": ["此拟合将 API 价格用作衡量标尺。它不是提供商发布的美元额度。", "Este ajuste usa precios de API como regla de medida. No es un límite en dólares publicado por el proveedor."],
  "This fit uses speed-priced API prices as a measuring stick. It is not a provider-published dollar allowance.": ["此拟合将按速度档定价 API 价格用作衡量标尺。它不是提供商发布的美元额度。", "Este ajuste usa precios de API con precio según velocidad como regla de medida. No es un límite en dólares publicado por el proveedor."],
  "Speed-priced all-data median": ["按速度档定价的全部数据中位数", "Mediana con precio según velocidad de todos los datos"],
  "Expected from speed-priced API cost": ["按按速度档定价 API 成本推断的预期变化", "Esperado según el coste de API con precio según velocidad"],
  "Speed-priced API-equivalent usage": ["按速度档定价 API 等价使用量", "Uso equivalente de API con precio según velocidad"],
  "Standard API-equivalent cost": ["Standard 费率 API 等价成本", "Coste equivalente de API con tarifa Standard"],
  "Standard API equivalent": ["Standard 费率 API 等价值", "Equivalente de API con tarifa Standard"],
  "A results card you can post": ["可发布的结果卡片", "Una tarjeta de resultados que puedes publicar"],
  "Reference pending": ["参考待定", "Referencia pendiente"],
  // The exact-windows pager (owner-directed, 2026-08-08).
  "Previous": ["上一页", "Anterior"],
  "Next": ["下一页", "Siguiente"],
  // The residual panel's cumulative line, named with its exact semantics
  // (owner-directed, 2026-08-08).
  "The second line is cumulative drift: the running sum of each bucket’s observed-minus-expected movement, restarted at every window boundary or track change.": [
    "第二条线是累计漂移：每个分桶“观测减预期”变化的累计和，在每个窗口边界或额度轨道变化处重新开始。",
    "La segunda línea es la deriva acumulada: la suma corrida del movimiento observado menos esperado de cada intervalo, reiniciada en cada límite de ventana o cambio de seguimiento.",
  ],
  "A results card is generated once local evidence is available.": ["本地证据可用后会生成结果卡片。", "Se genera una tarjeta de resultados cuando hay evidencia local disponible."],
  "02 · Weekly allowance": ["02 · 每周额度", "02 · Límite semanal"],
  "Our best estimate of the seven-day limit": ["我们对七天限额的最佳估计", "Nuestra mejor estimación del límite de siete días"],
  "Speed-priced all-data median": ["按速度档定价的全部数据中位数", "Mediana con precio según velocidad de todos los datos"],
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
  "Expected from speed-priced API cost": ["按按速度档定价 API 成本推断的预期变化", "Esperado según el coste de API con precio según velocidad"],
  "Missing quota bracket": ["缺少额度区间", "Falta el tramo de cuota"],
  "No timeline loaded": ["未加载时间线", "No se cargó ninguna cronología"],
  "Connect the local companion or choose the labeled demo.": ["连接本地伴随程序或选择带标签的演示。", "Conecta el acompañante local o elige la demostración etiquetada."],
  "Observed versus calculated movement": ["观测变化与计算变化", "Movimiento observado frente al calculado"],
  "The difference between provider-reported quota movement and the movement implied by local usage changes. Quiet periods with no activity and no quota change are neutral, not errors.": ["提供方报告的额度变化与本地使用变化所推算变化之间的差值。没有活动且额度未变化的安静时段是中性状态，不是错误。", "La diferencia entre el movimiento de cuota informado por el proveedor y el implícito en los cambios de uso local. Los períodos sin actividad ni cambios de cuota son neutros, no errores."],
  "Residual = observed quota change minus cost-implied change. Positive values mean the allowance fell faster than the token model predicted. The axis covers the same date range as the calibration chart above; windows that cannot be differenced are shaded gaps, never zeros.": ["残差 = 观测到的额度变化减去成本推算的变化。正值表示额度下降得比令牌模型预测的更快。该轴覆盖与上方校准图相同的日期范围；无法求差的窗口会显示为阴影间隙，绝不是零。", "Residual = cambio de cuota observado menos cambio implícito por el coste. Los valores positivos significan que el límite cayó más rápido de lo que predijo el modelo de tokens. El eje cubre el mismo intervalo de fechas que el gráfico de calibración anterior; las ventanas que no se pueden diferenciar son huecos sombreados, nunca ceros."],
  "No residual evidence loaded.": ["未加载残差证据。", "No se cargó evidencia de residuales."],
  "Inspect exact periods": ["检查精确期间", "Inspeccionar períodos exactos"],
  "Exact windows and evidence state": ["精确窗口和证据状态", "Ventanas exactas y estado de evidencia"],
  // Deviation-period detector panel headings (static copy; the period rows and
  // empty state are localized from WEB_MESSAGES).
  "Divergence periods": ["背离时段", "Períodos de divergencia"],
  "Where observed and priced usage diverge": ["观测用量与计价用量的背离之处", "Dónde divergen el uso observado y el uso con precio"],
  "Sustained stretches where provider-reported quota movement and the movement implied by priced usage persistently disagree. A single spike that cancels out is not listed. Expand a period to reprice just that window and see its cost mix by model and speed.": ["提供方报告的额度变化与计价用量所推算的变化持续不一致的连续时段。单个会相互抵消的尖峰不会被列出。展开某个时段可仅对该窗口重新计价，并按模型和速度查看其成本构成。", "Tramos sostenidos en los que el movimiento de cuota informado por el proveedor y el implícito en el uso con precio discrepan de forma persistente. Un pico aislado que se cancela no se incluye. Despliega un período para recalcular el precio de esa ventana y ver su mezcla de costes por modelo y velocidad."],
  "Largest unexplained quota movement periods": ["最大的未解释额度变化期间", "Períodos con mayor movimiento de cuota sin explicación"],
  "Evidence state": ["证据状态", "Estado de evidencia"],
  "No periods loaded.": ["未加载期间。", "No se cargaron períodos."],
  "7d": ["7 天", "7 días"],
  "31d": ["31 天", "31 días"],
  "24h": ["24 小时", "24 h"],
  "04 · Cost accounting": ["04 · 成本核算", "04 · Contabilidad de costes"],
  "How the estimate was calculated": ["估计的计算方式", "Cómo se calculó la estimación"],
  "30d": ["30 天", "30 días"],
  "90d": ["90 天", "90 días"],
  "API pricing is a measuring stick, not your bill.": ["API 定价是衡量标尺，不是你的账单。", "Los precios de API son una regla de medida, no tu factura."],
  "Each local usage change uses the public API price that was in effect when it occurred, with the published Priority (Fast) price ratio when applicable. It is an equivalent for comparison, not an invoice.": ["每个本地使用变化都使用其发生时有效的公开 API 价格，并在适用时采用公开的 Fast 倍数。它是用于比较的等值，而不是账单。", "Cada cambio de uso local usa el precio público de API vigente cuando ocurrió, con el multiplicador Fast publicado cuando corresponde. Es un equivalente para comparar, no una factura."],
  "Token components": ["令牌组成", "Componentes de tokens"],
  "Token count": ["令牌数量", "Recuento de tokens"],
  "Every token belongs to one non-overlapping component. Output text excludes reasoning tokens; combined output is only used when a source does not provide that split.": ["每个令牌只属于一个不重叠的组成部分。输出文本不包括推理令牌；只有在来源未提供该拆分时才使用合并输出。", "Cada token pertenece a un componente no superpuesto. El texto de salida excluye los tokens de razonamiento; la salida combinada solo se usa cuando una fuente no proporciona esa división."],
  "Cost contribution": ["成本贡献", "Contribución al coste"],
  "Standard API-equivalent cost": ["Standard API 等值成本", "Coste equivalente de API Standard"],
  "Standard-rate API equivalent by component. Coverage and price provenance stay visible without adding a guessed cost.": ["按组成部分计算的标准费率 API 等值。覆盖率和价格来源保持可见，不会加入猜测的成本。", "Equivalente de API de tarifa estándar por componente. La cobertura y la procedencia del precio permanecen visibles sin añadir un coste inventado."],
  "Models": ["模型", "Modelos"],
  "Model": ["模型", "Modelo"],
  "Usage changes": ["使用变化", "Cambios de uso"],
  "Tokens": ["令牌", "Tokens"],
  "Standard API equivalent": ["Standard API 等值", "Equivalente de API Standard"],
  "API equivalent": ["API 等值", "Equivalente de API"],
  "See possible switch overhead": ["查看可能的切换开销", "Ver el posible coste adicional al cambiar"],
  "See cache reuse between turns": ["查看轮次之间的缓存复用", "Ver la reutilización de caché entre turnos"],
  "See recent large cache drops": ["查看近期缓存大幅下降", "Ver las caídas grandes de caché recientes"],
  "Using real local data": ["使用真实本地数据", "Usando datos locales reales"],
  "Cache reuse between turns": ["轮次之间的缓存复用", "Reutilización de caché entre turnos"],
  "Did the cache carry over?": ["缓存延续了吗？", "¿Se conservó la caché?"],
  "Follow-up turns with the same model and settings, grouped by time since the previous turn.": ["按距上一个轮次的时间，对模型和设置相同的后续轮次进行分组。", "Turnos de seguimiento con el mismo modelo y la misma configuración, agrupados por el tiempo desde el turno anterior."],
  "follow-up turns checked": ["已检查的后续轮次", "turnos de seguimiento comprobados"],
  "reused more than half": ["复用了超过一半", "reutilizaron más de la mitad"],
  "reused half or less": ["复用了一半或更少", "reutilizaron la mitad o menos"],
  "0%": ["0%", "0%"],
  "No eligible follow-up turns were found in this period.": ["此期间未找到符合条件的后续轮次。", "No se encontraron turnos de seguimiento aptos en este período."],
  "What one hex means": ["一个六边形代表什么", "Qué significa un hexágono"],
  "Longer gaps can show a pattern, but they do not prove a provider cache timeout.": ["较长的间隔可以显示规律，但不能证明提供方的缓存超时。", "Los intervalos más largos pueden mostrar un patrón, pero no demuestran un vencimiento de caché del proveedor."],
  "Checked follow-ups keep the same model and settings, include enough context for the earlier cache to have carried over, and exclude detected compactions. Only totals are shown—never prompts, identities, paths, or exact timestamps.": ["已检查的后续轮次保持相同的模型和设置，包含足够的上下文以承载之前的缓存，并排除检测到的上下文压缩。这里只显示汇总，不显示提示词、身份、路径或精确时间戳。", "Los seguimientos comprobados mantienen el mismo modelo y la misma configuración, contienen contexto suficiente para conservar la caché anterior y excluyen las compactaciones detectadas. Solo se muestran totales, nunca prompts, identidades, rutas ni marcas de tiempo exactas."],
  "The chart counts every checked follow-up by cache-read outcome. The tables below narrow that to large drops where lost reuse can also be bounded and costed. Detected compactions and shortened contexts stay out of the cost estimate.": ["图表按缓存读取结果统计每个已检查的后续轮次。下方表格进一步缩小范围，只显示能够限定复用损失并估算成本的大幅下降。检测到的上下文压缩和缩短的上下文不会计入成本估算。", "El gráfico cuenta cada seguimiento comprobado según el resultado de lectura de caché. Las tablas limitan el análisis a caídas grandes cuya reutilización perdida también puede acotarse y valorarse. Las compactaciones detectadas y los contextos reducidos quedan fuera del coste estimado."],
  "Estimated overhead by wait time": ["按等待时间估算的开销", "Coste estimado por tiempo de espera"],
  "Estimated cache-reuse overhead by time between turns": ["按轮次间隔划分的缓存复用开销估算", "Coste estimado de reutilización de caché por tiempo entre turnos"],
  "Large drops with lost reuse": ["存在复用损失的大幅下降", "Caídas grandes con reutilización perdida"],
  "out of follow-ups checked": ["占已检查的后续轮次", "de los seguimientos comprobados"],
  "Recent large cache drops": ["近期缓存大幅下降", "Caídas grandes de caché recientes"],
  "A component row shows no usage-change count, because one usage change carries every component at once and cannot be divided between them. Where a model states no API equivalent, its components state none either.": ["组成部分行不显示使用变更计数，因为一次使用变更同时包含所有组成部分，无法在它们之间划分。若某个模型没有 API 等价值，其组成部分也不会显示。", "Una fila de componente no muestra recuento de cambios de uso, porque un cambio de uso incluye todos los componentes a la vez y no puede dividirse entre ellos. Cuando un modelo no indica equivalente de API, sus componentes tampoco lo indican."],
  "Both share columns are a share of the whole period, so components add up to their model and models add up to the total.": ["两个占比列均相对于整个期间，因此各组成部分之和等于其模型，各模型之和等于总计。", "Ambas columnas de proporción son respecto al período completo, por lo que los componentes suman su modelo y los modelos suman el total."],
  "These recent rows pair an adjacent model or reasoning change with an observed material cache-read drop within five minutes. The cache-read change is observed; its relationship to the setting change is inferred.": ["这些近期记录将相邻的模型或推理强度更改与五分钟内观测到的缓存读取量大幅下降配对。缓存读取量的变化是观测结果；它与设置更改之间的关系是推断结果。", "Estas filas recientes emparejan un cambio adyacente de modelo o razonamiento con una caída material observada de lectura de caché en un plazo de cinco minutos. El cambio de lectura de caché se observa; su relación con el cambio de configuración se infiere."],
  "Recent covered switch-overhead comparisons at Standard API rates; not a period total": ["近期已覆盖的切换开销比较，按 Standard API 费率计算；并非期间总额", "Comparaciones recientes con cobertura del coste al cambiar, con tarifas de API Standard; no es un total del período"],
  "Configuration change": ["配置更改", "Cambio de configuración"],
  "Cache read": ["缓存读取", "Lectura de caché"],
  "Estimated lost reuse": ["估算的复用损失", "Reutilización perdida estimada"],
  "estimated overhead from cache drops": ["缓存下降的估算开销", "coste estimado de las caídas de caché"],
  "Est. lost reuse": ["估算的复用损失", "Reutilización perdida estimada"],
  "See possible cache-continuity overhead": ["查看可能的缓存连续性开销", "Ver el posible coste adicional de continuidad de caché"],
  "The first table groups comparable adjacent user turns by elapsed time; the recent rows below show qualifying material cache-read drops while the effective model, reasoning, routing, and surface remained unchanged. Time is evidence, not an eligibility rule; compactions and contracted contexts stay out of the cost.": ["第一张表按经过时间对可比较的相邻用户轮次分组；下方的近期记录显示符合条件的缓存读取量大幅下降，且有效模型、推理强度、路由和界面均未改变。时间仅作为证据，而不是资格规则；上下文压缩和收缩的上下文不会计入成本。", "La primera tabla agrupa los turnos adyacentes comparables del usuario por tiempo transcurrido; las filas recientes de abajo muestran las caídas materiales de lectura de caché que cumplen los requisitos, sin cambios en el modelo efectivo, el razonamiento, el enrutamiento ni la superficie. El tiempo es evidencia, no una regla de inclusión; las compactaciones y los contextos reducidos no se incluyen en el coste."],
  "By time between turns": ["按轮次间隔", "Por tiempo entre turnos"],
  "Possible cache-continuity overhead by time between turns": ["按轮次间隔划分的可能缓存连续性开销", "Posible coste adicional de continuidad de caché por tiempo entre turnos"],
  "Material drops / comparable returns": ["大幅下降 / 可比较返回", "Caídas materiales / retornos comparables"],
  "Recent qualifying drops": ["近期符合条件的下降", "Caídas recientes que cumplen los requisitos"],
  "Recent covered cache-continuity comparisons at Standard API rates; not a period total": ["近期已覆盖的缓存连续性比较，按 Standard API 费率计算；并非期间总额", "Comparaciones recientes con cobertura de continuidad de caché, con tarifas de API Standard; no es un total del período"],
  "Time between turns": ["轮次间隔", "Tiempo entre turnos"],
  "Unchanged configuration": ["未更改的配置", "Configuración sin cambios"],
  "See experimental side-chat estimate": ["查看实验性侧聊估算", "Ver la estimación experimental de chats laterales"],
  "This development-only estimate finds confirmed desktop side-chat lifecycles and prices deduplicated sampling markers that still survive in numeric local diagnostics. The active window is approximately 10 days; expired or rotated partitions are unknown and are not reconstructed. Active-context volume is observed, while input, cache, output, and reasoning components are reconstructed. Ordinary calls use the owner-directed mostly-warm point; an observed compaction makes the next point cold. Auto Review and other reviewed aliases retain their conditional alias-rate assumption. Exact totals remain unchanged. Surviving eligible estimates are speed-weighted and added only to the experimental red line, calibration metrics, and AUC, with the exact-ledger baseline kept beside them.": ["此仅用于开发的估算会查找已确认的桌面侧聊生命周期，并为本地数值诊断中仍保留的已去重采样标记计价。当前窗口约为 10 天；已过期或轮换的分区为未知，且不会重建。活动上下文量是观测值，而输入、缓存、输出和推理组成均为重建。普通调用使用用户指定的主要为热缓存点估算；观测到压缩后，下一个点按冷缓存处理。Auto Review 和其他已审核别名保留条件性别名费率假设。精确总额保持不变。仍保留且符合条件的估算会按速度加权，只加入实验性红线、校准指标和 AUC，并保留精确账本基线作对照。", "Esta estimación solo para desarrollo detecta ciclos confirmados de chats laterales y valora marcadores deduplicados que aún sobreviven en los diagnósticos numéricos locales. La ventana activa es de unos 10 días; las particiones caducadas o rotadas son desconocidas y no se reconstruyen. Se observa el volumen de contexto activo, mientras que los componentes de entrada, caché, salida y razonamiento se reconstruyen. Las llamadas ordinarias usan el punto mayormente caliente indicado; una compactación observada hace frío el punto siguiente. Auto Review y otros alias revisados conservan su supuesto condicional. Los totales exactos no cambian. Las estimaciones elegibles se ponderan por velocidad y se añaden solo a la línea roja experimental, las métricas de calibración y el AUC, manteniendo al lado la base del registro exacto."],
  "Retained sampling calls": ["保留的采样调用", "Llamadas de muestreo conservadas"],
  "Experimental side-chat sampling-call estimates": ["实验性侧聊采样调用估算", "Estimaciones experimentales de llamadas de chats laterales"],
  "Configuration": ["配置", "Configuración"],
  "Turn": ["轮次", "Turno"],
  "Active context": ["活动上下文", "Contexto activo"],
  "Cache assumption": ["缓存假设", "Supuesto de caché"],
  "Estimated Standard API equivalent": ["估算的 Standard API 等价值", "Equivalente de API Standard estimado"],
  "Share one anonymous summary": ["分享一份匿名摘要", "Comparte un resumen anónimo"],
  "What leaves this Mac — and what never does": ["什么会离开这台 Mac，以及什么永远不会", "Qué sale de este Mac y qué no sale nunca"],
  "Not signed in": ["未登录", "Sin sesión iniciada"],
  // The pre-JS default of the identity next-action line; renderHostedIdentity
  // rewrites it per state, but the static copy still legacy-translates on load.
  "Sign in with Google or Apple to contribute.": ["使用 Google 或 Apple 登录即可贡献。", "Inicia sesión con Google o Apple para contribuir."],
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
  "TiboTattle · not affiliated with OpenAI or Thibault Sottiaux": ["TiboTattle · 与 OpenAI 或 Thibault Sottiaux 无关", "TiboTattle · sin afiliación con OpenAI ni con Thibault Sottiaux"],
  "Insufficient": ["不足", "Insuficiente"],
  "There is not yet a matched quota-and-cost window to compare.": ["尚无可比较的匹配额度与成本窗口。", "Aún no hay una ventana de cuota y coste coincidente para comparar."],
  "Not estimable": ["无法估算", "No estimable"],
  "No points fall inside this zoomed interval. Reset the view to return to the available evidence.": ["此缩放区间内没有数据点。请重置视图以返回可用证据。", "No hay puntos dentro de este intervalo ampliado. Restablece la vista para volver a la evidencia disponible."],
  "This historical calibration view has no per-window reset annotations. Treat it as diagnostic evidence, not a live allowance reading.": ["此历史校准视图没有逐窗口的重置注释。请将其视为诊断证据，而非实时额度读数。", "Esta vista histórica de calibración no tiene anotaciones de restablecimiento por ventana. Trátala como evidencia diagnóstica, no como una lectura de límite en vivo."],
  "No windows fall inside this date range.": ["此日期范围内没有窗口。", "No hay ventanas dentro de este intervalo de fechas."],
  "No weekly estimates loaded.": ["未加载每周估计。", "No se cargaron estimaciones semanales."],
  "Awaiting local evidence.": ["正在等待本地证据。", "A la espera de evidencia local."],
  "Connecting…": ["正在连接…", "Conectando…"],
  "No real usage is displayed": ["未显示真实使用情况", "No se muestra uso real"],
  "Starting local analysis…": ["正在开始本地分析…", "Iniciando análisis local…"],
  "Update running; reconnecting…": ["更新正在运行；正在重新连接…", "Actualización en curso; reconectando…"],
  "Continuing local analysis…": ["正在继续本地分析…", "Continuando el análisis local…"],
  "Finalizing bounded pause…": ["正在完成有界暂停…", "Finalizando la pausa limitada…"],
  // The refresh failure code app_record_checkpoint_unavailable: the durable
  // analysis checkpoint vanished mid-run. The sentence must exist in every
  // supported language alongside the English copy map in app.js.
  "The analysis checkpoint stored on this Mac disappeared while the analysis was running, so TiboTattle stopped rather than continue without it. Existing results are unchanged; run the analysis again to start over safely.": ["分析运行期间，这台 Mac 上保存的分析检查点丢失，TiboTattle 因此停止而不是在缺少它的情况下继续。现有结果保持不变；再次运行分析即可安全地重新开始。", "El punto de control del análisis guardado en este Mac desapareció mientras el análisis se ejecutaba, así que TiboTattle se detuvo en lugar de continuar sin él. Los resultados existentes no cambian; ejecuta el análisis de nuevo para empezar de forma segura desde el principio."],
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

  function usesResolvedLanguagePickerValue(element) {
    return element?.hasAttribute?.("data-language-picker-resolved") === true;
  }

  function languagePickerValue(element) {
    return usesResolvedLanguagePickerValue(element) ? locale : preference;
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
    const options = usesResolvedLanguagePickerValue(element)
      ? LANGUAGE_OPTIONS.filter(({ id }) => id !== SYSTEM_LANGUAGE_PREFERENCE)
      : LANGUAGE_OPTIONS;
    for (const option of options) {
      const node = documentRef.createElement("option");
      node.value = option.id;
      node.textContent = languageOptionLabel(option);
      element.append(node);
    }
    element.value = languagePickerValue(element);
  }

  function refreshLanguagePickers() {
    for (const element of documentRef?.querySelectorAll?.("[data-language-picker]") ?? []) {
      bindLanguagePicker(element);
      element.value = languagePickerValue(element);
      element.setAttribute("aria-label", t("language.label"));
    }
  }

  function announceLanguageChange() {
    const option = LANGUAGE_OPTIONS.find(({ id }) => id === locale)
      ?? LANGUAGE_OPTIONS.find(({ id }) => id === preference);
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
