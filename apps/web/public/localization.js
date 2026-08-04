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

function canonicalLocale(value) {
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
  "dashboard.unavailable.noLocalEvidence": ["No local evidence", "没有本地证据", "Sin evidencia local"],
  "dashboard.unavailable.offline": ["Offline", "离线", "Sin conexión"],
  "dashboard.unavailable.emptyState": ["This empty state is intentional. Demo values are never substituted automatically.", "此空状态是有意设计的。绝不会自动替换为演示值。", "Este estado vacío es intencional. Los valores de demostración nunca se sustituyen automáticamente."],
  "dashboard.quota.observations": ["Quota observations", "额度观测", "Observaciones de cuota"],
  "dashboard.quota.insufficient": ["Insufficient", "不足", "Insuficiente"],
  "dashboard.quota.noCurrent": ["The local companion has not exposed a current normal Codex allowance window.", "本地伴随程序尚未提供当前的正常 Codex 额度窗口。", "El acompañante local no ha expuesto una ventana actual de asignación normal de Codex."],
  "dashboard.quota.demo": ["Demo", "演示", "Demostración"],
  "dashboard.quota.observed": ["Observed", "已观测", "Observado"],
  "dashboard.quota.remaining": ["{value} remaining", "剩余 {value}", "{value} restante"],
  "dashboard.quota.used": ["{value} used", "已使用 {value}", "{value} usado"],
  "dashboard.quota.usedUnknown": ["Used unknown", "已用量未知", "Uso desconocido"],
  "dashboard.quota.resets": ["Resets {time}", "重置时间：{time}", "Se restablece {time}"],
  "dashboard.quota.resetUnknown": ["Reset unknown", "重置时间未知", "Restablecimiento desconocido"],
  "dashboard.quota.observedAt": ["Observed {time} · {attribution}", "观测于 {time} · {attribution}", "Observado {time} · {attribution}"],
  "dashboard.quota.attributionPseudonymous": ["pseudonymous account attributed", "已归因于假名化帐户", "cuenta seudónima atribuida"],
  "dashboard.quota.attributionUnavailable": ["account unattributed", "未归因帐户", "cuenta sin atribución"],
  "dashboard.pricing.noWeightedTitle": ["No usage in this period could be weighted, so the Standard-rate total is shown unchanged.", "此期间没有可加权的使用量，因此显示未变动的 Standard 费率总额。", "No se pudo ponderar ningún uso en este período, por lo que se muestra sin cambios el total a tarifa Standard."],
  "dashboard.pricing.noCoverage": ["Price coverage is not available", "价格覆盖率不可用", "La cobertura de precios no está disponible"],
  "dashboard.pricing.coverage": ["{percent} priced · {method}{provenance}", "已定价 {percent} · {method}{provenance}", "{percent} con precio · {method}{provenance}"],
  "dashboard.pricing.noCoverageWithHistory": ["Price coverage is not available · {history}", "价格覆盖率不可用 · {history}", "La cobertura de precios no está disponible · {history}"],
  "dashboard.pricing.coverageWithHistory": ["{percent} priced · {method}{provenance} · {history}", "已定价 {percent} · {method}{provenance} · {history}", "{percent} con precio · {method}{provenance} · {history}"],
  "dashboard.pricing.registryProvenance": [" · price registry {version}{observedAt}", " · 价格登记表 {version}{observedAt}", " · registro de precios {version}{observedAt}"],
  "dashboard.pricing.registryObservedAt": [" ({time})", "（{time}）", " ({time})"],
  "dashboard.pricing.replaySafe": ["replay-safe · {count} inherited child snapshots excluded", "可安全重放 · 已排除 {count} 个继承的子快照", "seguro para reproducción · se excluyeron {count} instantáneas secundarias heredadas"],
  "dashboard.pricing.staleReplaySafe": ["stale replay-safe cache · {count} inherited child snapshots excluded", "陈旧的可安全重放缓存 · 已排除 {count} 个继承的子快照", "caché seguro para reproducción desactualizado · se excluyeron {count} instantáneas secundarias heredadas"],
  "dashboard.pricing.legacyProjection": ["legacy projection; replay exclusion has not been verified", "旧版投影；尚未验证重放排除", "proyección heredada; no se ha verificado la exclusión de reproducción"],
  "dashboard.pricing.noComponents": ["No token-component accounting was returned.", "未返回令牌组件核算。", "No se devolvió contabilidad por componente de token."],
  "dashboard.pricing.unpriced": ["Unpriced", "未定价", "Sin precio"],
  "dashboard.pricing.partiallyPriced": ["{amount} + unpriced", "{amount} + 未定价", "{amount} + sin precio"],
  "dashboard.pricing.tokens": ["{count} tokens", "{count} 个令牌", "{count} tokens"],
  "dashboard.pricing.tokensWithUnpriced": ["{tokens} tokens · {unpriced} unpriced", "{tokens} 个令牌 · {unpriced} 未定价", "{tokens} tokens · {unpriced} sin precio"],
  "dashboard.pricing.historyScanningComplete": ["History index scanning; last verified coverage complete", "历史索引正在扫描；上次已验证覆盖完整", "El índice histórico se está analizando; la última cobertura verificada está completa"],
  "dashboard.pricing.historyScanningPartial": ["History index scanning; last verified coverage partial", "历史索引正在扫描；上次已验证覆盖不完整", "El índice histórico se está analizando; la última cobertura verificada es parcial"],
  "dashboard.pricing.historyComplete": ["History index complete", "历史索引完成", "Índice histórico completo"],
  "dashboard.pricing.historyDiskSpace": ["History index partial; insufficient local disk space to stage the next safe archive pass", "历史索引部分完成；本地磁盘空间不足，无法准备下一次安全归档扫描", "Índice histórico parcial; no hay espacio local suficiente para preparar el siguiente pase seguro del archivo"],
  "dashboard.pricing.historyStorageUnavailable": ["History index partial; local disk headroom could not be verified for the next safe archive pass", "历史索引部分完成；无法验证下一次安全归档扫描所需的本地磁盘空间", "Índice histórico parcial; no se pudo verificar el espacio libre local para el siguiente pase seguro del archivo"],
  "dashboard.pricing.historyNotStarted": ["History index partial; archive scan has not started", "历史索引部分完成；归档扫描尚未开始", "Índice histórico parcial; el análisis del archivo no ha comenzado"],
  "dashboard.pricing.historyProgress": ["History index partial; {indexed}/{total} sources indexed", "历史索引部分完成；已索引 {indexed}/{total} 个来源", "Índice histórico parcial; {indexed}/{total} fuentes indexadas"],
  "dashboard.pricing.historyResume": ["History index partial; resume local analysis to continue", "历史索引部分完成；恢复本地分析以继续", "Índice histórico parcial; reanuda el análisis local para continuar"],
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
  "dashboard.calibration.noRate": ["There is not yet enough matched cost and quota evidence for a positive fitted rate. API prices remain a measuring stick, not a subscription charge.", "尚无足够的匹配成本和额度证据来得出正的拟合费率。API 价格仍只是衡量尺，而不是订阅费用。", "Todavía no hay suficiente evidencia coincidente de coste y cuota para una tasa ajustada positiva. Los precios de API siguen siendo una vara de medir, no un cargo de suscripción."],
  "dashboard.calibration.withRange": ["The central fit implies a full 100-point allowance near {amount} API equivalent. The 80% range ({lower}–{upper}) describes variation across qualifying reset periods; it is not an 80% probability or a provider-published dollar cap.", "中心拟合表明完整的 100 点额度约为 {amount} 的 API 等价值。80% 区间（{lower}–{upper}）描述合格重置周期之间的变化；它不是 80% 概率，也不是提供商公布的美元上限。", "El ajuste central implica una asignación completa de 100 puntos cercana a {amount} de equivalente de API. El intervalo del 80 % ({lower}–{upper}) describe la variación entre períodos de restablecimiento que cumplen los requisitos; no es una probabilidad del 80 % ni un límite monetario publicado por el proveedor."],
  "dashboard.calibration.withoutRange": ["The central fit implies a full 100-point allowance near {amount} API equivalent, but there is not yet a usable across-reset range. This is not a provider-published dollar cap.", "中心拟合表明完整的 100 点额度约为 {amount} 的 API 等价值，但尚无可用的跨重置区间。这不是提供商公布的美元上限。", "El ajuste central implica una asignación completa de 100 puntos cercana a {amount} de equivalente de API, pero todavía no hay un intervalo utilizable entre restablecimientos. No es un límite monetario publicado por el proveedor."],
  "dashboard.timeWindow.fifteenMinutes": ["15-minute", "15 分钟", "15 minutos"],
  "dashboard.timeWindow.hours": ["{count}-hour", "{count} 小时", "{count} horas"],
  "dashboard.timeline.title": ["{window} rolling quota change versus cost-implied change", "{window} 滚动额度变化与成本推断变化的对比", "Cambio móvil de cuota de {window} frente al cambio implícito por coste"],
  "dashboard.timeline.liveCopy": ["Incrementos locales seguros para repetición · eje del gráfico en {timeZone} · horas locales y UTC exactas más abajo", "可安全重放的本地增量 · 图表轴为 {timeZone} · 下方显示精确本地时间和 UTC 时间", "Incrementos locales seguros para reproducción · eje del gráfico en {timeZone} · horas locales y UTC exactas abajo"],
  "dashboard.timeline.historicalCopy": ["Historical local calibration artifact from {generatedAt} · recent quota snapshots are too sparse to bracket {window} endpoints", "来自 {generatedAt} 的历史本地校准产物 · 最近的额度快照过于稀疏，无法界定 {window} 的端点", "Artefacto histórico de calibración local de {generatedAt} · las instantáneas recientes de cuota son demasiado escasas para acotar los extremos de {window}"],
  "dashboard.timeline.notComparableYet": ["Not comparable yet", "尚不可比较", "Aún no comparable"],
  "dashboard.timeline.noBracket": ["Cost history exists, but quota observations do not bracket any {window} window in this date range. The calculated line is hidden until there is measured evidence to compare it with.", "存在成本历史记录，但额度观测无法在此日期范围内界定任何 {window} 窗口。在有可供比较的测量证据前，计算线会保持隐藏。", "Existe historial de costes, pero las observaciones de cuota no delimitan ninguna ventana de {window} en este intervalo de fechas. La línea calculada permanece oculta hasta que haya evidencia medida con la que compararla."],
  "dashboard.timeline.missingData": ["This is a missing-data state, not a zero-usage period.", "这是缺失数据状态，不是零使用期。", "Es un estado de datos faltantes, no un período de uso cero."],
  "dashboard.timeline.observedQuota": ["Observed quota change", "观测到的额度变化", "Cambio de cuota observado"],
  "dashboard.timeline.expectedCost": ["Expected from API cost", "按 API 成本推断的预期变化", "Esperado según el coste de API"],
  "dashboard.timeline.percentagePoints": ["Percentage points", "百分点", "Puntos porcentuales"],
  "dashboard.timeline.movementTitle": ["{window} rolling quota movement", "{window} 滚动额度变化", "Movimiento móvil de cuota de {window}"],
  "dashboard.timeline.chartDescription": ["Observed quota movement compared with movement implied by priced token usage. The horizontal axis is {timeZone}.", "将观测到的额度变化与按定价令牌使用量推断的变化进行比较。水平轴为 {timeZone}。", "Movimiento de cuota observado comparado con el movimiento implícito por el uso de tokens con precio. El eje horizontal es {timeZone}."],
  "dashboard.timeline.lowConfidence": ["Low confidence: only {visible}; {excluded}.", "置信度较低：仅显示 {visible}；{excluded}。", "Confianza baja: solo {visible}; {excluded}."],
  "dashboard.timeline.excludedShown": ["{shown}. {excluded} and are shaded above; do not read them as zero usage.", "{shown}。{excluded}，并在上方显示为阴影；不要将它们理解为零使用。", "{shown}. {excluded}, se muestran sombreadas arriba; no las interpretes como uso cero."],
  "dashboard.timeline.allMatched": ["{visible}. This compares observed percentage-point movement with a priced-token estimate; it is not a provider-published allowance.", "{visible}。这会将观测到的百分点变化与按定价令牌估算值进行比较；它不是提供商公布的额度。", "{visible}. Esto compara el movimiento observado en puntos porcentuales con una estimación de tokens con precio; no es una asignación publicada por el proveedor."],
  "dashboard.timeline.resetView": ["Use Reset view to return to the selected date range.", "使用“重置视图”返回所选日期范围。", "Usa Restablecer vista para volver al intervalo de fechas seleccionado."],
  "dashboard.timeline.aria": ["Interactive quota timeline in {timeZone}. Use plus or minus to zoom, arrow keys to pan, Home to reset, or drag horizontally.", "{timeZone} 的交互式额度时间线。使用加号或减号缩放，方向键平移，Home 重置，或水平拖动。", "Cronología interactiva de cuota en {timeZone}. Usa más o menos para ampliar, las flechas para desplazar, Inicio para restablecer o arrastra horizontalmente."],
  "dashboard.timeline.status": ["Timeline shows {start} through {end}, a span of {span}.", "时间线显示从 {start} 到 {end}，跨度为 {span}。", "La cronología muestra de {start} a {end}, con una duración de {span}."],
  "dashboard.residual.partial": ["{computed} of {total} windows in this range have a computable residual. The other {missing} are shown as shaded gaps on the same axis, never as zero: {reasons}.", "此范围内 {total} 个窗口中有 {computed} 个具有可计算的残差。其余 {missing} 个会在同一轴上显示为阴影缺口，绝不显示为零：{reasons}。", "{computed} de las {total} ventanas de este intervalo tienen un residual calculable. Las otras {missing} se muestran como huecos sombreados en el mismo eje, nunca como cero: {reasons}."],
  "dashboard.priceEpoch.unverified": ["This build returned {registryVersion}, {reviewedAt}, but not event-time historical card selection for the fits.{rebuiltAt}", "此构建返回了 {registryVersion}、{reviewedAt}，但没有返回拟合所需的按事件时间选择历史价格卡。{rebuiltAt}", "Esta compilación devolvió {registryVersion}, {reviewedAt}, pero no la selección histórica de tarjetas por hora del evento para los ajustes.{rebuiltAt}"],
  "dashboard.priceEpoch.verified": ["Each fit selects the official card effective at each usage event timestamp from {registryVersion}, {reviewedAt}.{julyThirtyPricing}{mixedWindows}{historicalTotal}{rebuiltAt}", "每个拟合都从 {registryVersion}、{reviewedAt} 中选择在每个使用事件时间戳生效的官方价格卡。{julyThirtyPricing}{mixedWindows}{historicalTotal}{rebuiltAt}", "Cada ajuste selecciona la tarjeta oficial vigente en la marca de tiempo de cada evento de uso de {registryVersion}, {reviewedAt}.{julyThirtyPricing}{mixedWindows}{historicalTotal}{rebuiltAt}"],
  "dashboard.priceEpoch.reviewedAt": ["reviewed {date}", "审阅日期为 {date}", "revisado el {date}"],
  "dashboard.priceEpoch.noReviewDate": ["with no review date returned", "未返回审阅日期", "sin fecha de revisión devuelta"],
  "dashboard.priceEpoch.defaultRegistryVersion": ["reviewed official price table", "经审阅的官方价格表", "tabla oficial de precios revisada"],
  "dashboard.priceEpoch.rebuiltAt": [" The fits were last rebuilt {date}.", " 拟合最近一次重建于 {date}。", " Los ajustes se reconstruyeron por última vez el {date}."],
  "dashboard.priceEpoch.mixedTitle": ["Historical event-time prices span card windows", "按事件时间的历史价格跨越多个价格卡窗口", "Los precios históricos por hora del evento abarcan varias ventanas de tarjetas"],
  "dashboard.priceEpoch.singleTitle": ["Historical event-time prices used for each fit", "每个拟合使用的按事件时间历史价格", "Precios históricos por hora del evento usados para cada ajuste"],
  "dashboard.priceEpoch.noCardProvenance": [" No per-card provenance was returned, so this build does not claim whether the July 30 GPT-5.6 Terra/Luna change affects these fits.", " 未返回逐卡来源，因此此构建不声称 7 月 30 日 GPT-5.6 Terra/Luna 变更是否影响这些拟合。", " No se devolvió procedencia por tarjeta, por lo que esta compilación no afirma si el cambio de GPT-5.6 Terra/Luna del 30 de julio afecta a estos ajustes."],
  "dashboard.priceEpoch.postJulyCard": [" The lower official GPT-5.6 Terra/Luna cards effective July 30 are being used for retained events on or after that date; earlier events keep their earlier cards.", " 7 月 30 日生效的较低官方 GPT-5.6 Terra/Luna 价格卡正用于该日或之后的保留事件；较早事件保留其较早的价格卡。", " Las tarjetas oficiales más bajas de GPT-5.6 Terra/Luna vigentes el 30 de julio se usan para eventos retenidos en esa fecha o posteriores; los eventos anteriores conservan sus tarjetas previas."],
  "dashboard.priceEpoch.noPostJulyCard": [" No retained event in these fits uses the GPT-5.6 Terra/Luna post-July 30 card, so that lower-price change does not affect this view.", " 这些拟合中的保留事件没有使用 7 月 30 日之后的 GPT-5.6 Terra/Luna 价格卡，因此该降价不影响此视图。", "Ningún evento retenido de estos ajustes usa la tarjeta GPT-5.6 Terra/Luna posterior al 30 de julio, por lo que ese cambio de precio más bajo no afecta a esta vista."],
  "dashboard.priceEpoch.mixedWindows": [" At least one fit uses mixed official card windows.", " 至少有一个拟合使用混合的官方价格卡窗口。", " Al menos un ajuste usa ventanas mixtas de tarjetas oficiales."],
  "dashboard.priceEpoch.historicalTotal": [" The retained event-time historical total is {amount} USD; no current-card sensitivity total is claimed for this view.", " 保留的按事件时间历史总额为 {amount} 美元；此视图不声称有当前价格卡敏感度总额。", " El total histórico retenido por hora del evento es {amount} USD; esta vista no afirma un total de sensibilidad de tarjeta actual."],
  "dashboard.priceEpoch.noHistoricalTotal": [" No separate event-time historical total was returned for this view.", " 未为此视图返回单独的按事件时间历史总额。", " No se devolvió un total histórico por hora del evento separado para esta vista."],
  "contribution.signInCancelled": ["{provider} sign-in was cancelled. Nothing was uploaded.", "已取消 {provider} 登录。未上传任何内容。", "Se canceló el inicio de sesión con {provider}. No se cargó nada."],
  "contribution.signInStarting": ["Starting {provider} sign-in…", "正在开始 {provider} 登录…", "Iniciando sesión con {provider}…"],
  "contribution.signInIncomplete": ["{provider} sign-in did not complete. Nothing was uploaded. You can try again.", "{provider} 登录未完成。未上传任何内容。你可以重试。", "El inicio de sesión con {provider} no se completó. No se cargó nada. Puedes intentarlo de nuevo."],
  "contribution.signInDiscarded": ["{message} For safety, this page discarded the one-time sign-in; sign in again before retrying.", "{message} 为安全起见，此页面已丢弃一次性登录；重试前请重新登录。", "{message} Por seguridad, esta página descartó el inicio de sesión de un solo uso; vuelve a iniciar sesión antes de reintentar."],
  "contribution.acceptedReceipt": ["Accepted as {id}. The server reported {records}.", "已接受为 {id}。服务器报告了 {records}。", "Aceptado como {id}. El servidor informó {records}."],
  "contribution.deletedReceipt": ["Deleted {batches} and the pseudonymous hosted session.", "已删除 {batches} 和假名化托管会话。", "Se eliminaron {batches} y la sesión alojada seudónima."],
  "share.period.allRetained": ["all retained evidence", "全部保留证据", "toda la evidencia conservada"],
  "share.period.cachedThirtyOneDay": ["the cached 31-day window", "缓存的 31 天窗口", "la ventana en caché de 31 días"],
  "share.period.cachedThirtyOneDayCollector": ["the cached 31-day collector window", "缓存的 31 天收集器窗口", "la ventana del recopilador en caché de 31 días"],
  "share.period.lastDay": ["the last 24 hours", "过去 24 小时", "las últimas 24 horas"],
  "share.period.lastThirtyDays": ["the last 30 days", "过去 30 天", "los últimos 30 días"],
  "share.period.lastSevenDays": ["the last 7 days", "过去 7 天", "los últimos 7 días"],
  "share.period.recorded": ["the recorded period", "记录的期间", "el período registrado"],
  "share.window.fiveHour": ["five-hour allowance", "五小时额度", "asignación de cinco horas"],
  "share.window.other": ["observed allowance window", "观测到的额度窗口", "ventana de asignación observada"],
  "share.window.sevenDay": ["seven-day allowance", "七天额度", "asignación de siete días"],
  "share.stat.allowanceLeft": ["Allowance left", "剩余额度", "Asignación restante"],
  "share.stat.recordedActivity": ["Recorded activity", "记录的活动", "Actividad registrada"],
  "share.stat.estimatedAllowance": ["Estimated 7-day allowance", "估计的七天额度", "Asignación estimada de 7 días"],
  "share.value.notObserved": ["Not observed", "未观测到", "No observado"],
  "share.value.notAvailable": ["Not available", "不可用", "No disponible"],
  "share.value.notEstimable": ["Not estimable", "无法估计", "No estimable"],
  "share.detail.noCurrentAllowance": ["no current allowance window was observed", "未观测到当前额度窗口", "no se observó una ventana de asignación actual"],
  "share.detail.ofWindow": ["of the {window}", "属于{window}", "de la {window}"],
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
  "share.caveat.coverage": ["{percent} of recorded usage could be priced; the rest is left unpriced rather than estimated.", "记录的使用量中有 {percent} 可定价；其余部分保持未定价而不进行估算。", "Se pudo poner precio al {percent} del uso registrado; el resto queda sin precio en lugar de estimarse."],
  "share.title": ["Where my Codex allowance stands", "我的 Codex 额度现状", "Situación de mi asignación de Codex"],
  "share.subtitle.demo": ["Illustrative demo data. Not a measurement.", "示例性演示数据。不是测量结果。", "Datos de demostración ilustrativos. No son una medición."],
  "share.subtitle.local": ["Measured on my own Mac. Nothing left it.", "在我自己的 Mac 上测得。没有任何内容离开它。", "Medido en mi propio Mac. Nada salió de él."],
  "share.badge.demo": ["DEMO DATA", "演示数据", "DATOS DEMO"],
  "share.trend.label": ["7-day allowance estimates", "七天额度估计", "Estimaciones de asignación de 7 días"],
  "share.trend.empty": ["Not enough observed reset history yet.", "尚无足够的已观测重置历史。", "Aún no hay suficiente historial de restablecimientos observados."],
  "share.trend.emptyDetail": ["A completed reset becomes a point once enough of its allowance was observed.", "一旦观测到足够额度，完成的重置就会成为一个点。", "Un restablecimiento completado se convierte en un punto cuando se observa una parte suficiente de su asignación."],
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
  "share.footer": ["Local measurement · API equivalent, not a bill.", "本地测量 · API 等价值，不是账单。", "Medición local · equivalente de API, no una factura."],
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
  "aria.calibrationWindow": ["Calibration rolling comparison window", "校准滚动比较窗口", "Ventana de comparación móvil de calibración"],
  "aria.calibrationDateRange": ["Calibration date range", "校准日期范围", "Intervalo de fechas de calibración"],
  "aria.calibrationZoomPan": ["Calibration zoom and pan", "校准缩放和平移", "Zoom y desplazamiento de calibración"],
  "aria.calibrationLegend": ["Calibration chart legend", "校准图图例", "Leyenda del gráfico de calibración"],
  "aria.accountingPeriod": ["Accounting period", "核算期间", "Período contable"],
  "aria.rawLogsLocal": ["Raw logs remain local. The local companion extracts content-free metadata for the dashboard. Only a reviewed safe export can be sent to the contribution service.", "原始日志保留在本地。本地伴随程序为仪表板提取不含内容的元数据。只有经过审阅的安全导出可以发送到贡献服务。", "Los registros sin procesar permanecen locales. El acompañante local extrae metadatos sin contenido para el panel. Solo se puede enviar al servicio de contribución una exportación segura revisada."],
  "aria.contributionLookback": ["Contribution preparation lookback", "贡献准备回溯范围", "Período retrospectivo de preparación de contribución"],
  "aria.foregroundContributionControls": ["Foreground contribution controls", "前台贡献控制", "Controles de contribución en primer plano"],
  "aria.contributionBackendLifecycle": ["Contribution backend lifecycle", "贡献后端生命周期", "Ciclo de vida del backend de contribución"],
  "aria.privateContributionHistory": ["Private contribution history", "私有贡献历史", "Historial privado de contribuciones"],
  "title.panCalibrationEarlier": ["Pan calibration earlier", "向前平移校准", "Desplazar la calibración hacia antes"],
  "title.zoomOut": ["Zoom out", "缩小", "Alejar"],
  "title.zoomIn": ["Zoom in", "放大", "Acercar"],
  "title.panCalibrationLater": ["Pan calibration later", "向后平移校准", "Desplazar la calibración hacia después"],
  "installer.version": ["Version {version}", "版本 {version}", "Versión {version}"],
  "installer.requiresMacOS": ["Requires macOS {version} or later · {architecture}", "需要 macOS {version} 或更高版本 · {architecture}", "Requiere macOS {version} o posterior · {architecture}"],
  "installer.downloadKiB": ["{value} KiB download", "下载 {value} KiB", "Descarga de {value} KiB"],
  "installer.downloadMiB": ["{value} MiB download", "下载 {value} MiB", "Descarga de {value} MiB"],
  "installer.sha256": ["SHA-256 {value}", "SHA-256 {value}", "SHA-256 {value}"],
  "installer.appleSilicon": ["Apple silicon", "Apple 芯片", "Apple Silicon"],
  "installer.intel": ["Intel", "Intel", "Intel"],
  "installer.appleSiliconAndIntel": ["Apple silicon and Intel", "Apple 芯片和 Intel", "Apple Silicon e Intel"],
  "community.snapshotTitle": ["Seven-day community snapshot", "七天社区快照", "Resumen comunitario de siete días"],
  "community.snapshotUnavailable": ["Snapshot temporarily unavailable", "快照暂时不可用", "Resumen temporalmente no disponible"],
  "community.snapshotAvailable": ["Snapshot available", "快照可用", "Resumen disponible"],
  "community.snapshotPartlyAvailable": ["Snapshot partly available", "快照部分可用", "Resumen parcialmente disponible"],
  "community.noSnapshotPublished": ["No snapshot published yet", "尚未发布快照", "Aún no se ha publicado ningún resumen"],
  "community.snapshotWithdrawn": ["Snapshot withdrawn", "快照已撤回", "Resumen retirado"],
  "community.noSnapshotReleased": ["No snapshot released this week", "本周未发布快照", "No se publicó ningún resumen esta semana"],
  "community.snapshotUnavailableShort": ["Snapshot unavailable", "快照不可用", "Resumen no disponible"],
  "community.failedLoad": ["The published snapshot could not be loaded. Nothing is inferred from a failed request.", "无法加载已发布的快照。失败的请求不会推断任何结果。", "No se pudo cargar el resumen publicado. No se infiere nada de una solicitud fallida."],
  "community.reportedCause": ["Reported cause: {code}.", "报告原因：{code}。", "Causa informada: {code}."],
  "community.serviceReference": ["Service reference {reference}.", "服务参考：{reference}。", "Referencia del servicio {reference}."],
  "community.state.serviceUnavailable": ["Community activity is temporarily unavailable. This does not tell us whether a weekly snapshot exists.", "中心服务不可用。这并不能说明每周快照是否存在。", "La actividad de la comunidad no está disponible temporalmente. Esto no indica si existe un resumen semanal."],
  "community.state.developmentUnsafe": ["Live cumulative totals have not passed privacy review, so they are not displayed.", "实时累计总量尚未通过隐私审查，因此不会显示。", "Los totales acumulados en vivo no han pasado la revisión de privacidad, por lo que no se muestran."],
  "community.state.unsupportedSchema": ["This community snapshot cannot be displayed safely with this version of TiboTattle.", "此版本的 TiboTattle 无法安全显示这个社区快照。", "Este resumen comunitario no se puede mostrar de forma segura con esta versión de TiboTattle."],
  "community.state.notYetPublished": ["No stable weekly snapshot is available yet.", "尚无稳定的每周快照可用。", "Todavía no hay un resumen semanal estable disponible."],
  "community.state.withdrawn": ["This weekly revision was withdrawn for privacy or quality reasons. A replacement revision may be pending.", "此每周修订因隐私或质量原因被撤回。替代修订可能仍在等待中。", "Esta revisión semanal se retiró por motivos de privacidad o calidad. Puede haber una revisión de reemplazo pendiente."],
  "community.state.suppressed": ["This week did not pass the privacy checks required for publication. We do not disclose why or how close the cohort was.", "本周未通过发布所需的隐私检查。我们不会披露原因或群组距离门槛有多近。", "Esta semana no superó las comprobaciones de privacidad requeridas para su publicación. No revelamos por qué ni lo cerca que estuvo la cohorte."],
  "community.pending.releasedSnapshot": ["Released snapshot", "已发布快照", "Resumen publicado"],
  "community.pending.notLoaded": ["Not loaded", "未加载", "No cargado"],
  "community.pending.cohortLimit": ["Cohort limit estimate", "群组限额估计", "Estimación de límite de cohorte"],
  "community.pending.matchedQuota": ["Matched quota coverage", "匹配额度覆盖率", "Cobertura de cuota coincidente"],
  "community.pending.changeConfidence": ["Change confidence", "变化置信度", "Confianza del cambio"],
  "community.pending.notInContract": ["Not in current contract", "不在当前契约中", "No está en el contrato actual"],
  "community.noCapacityClaim": ["No community capacity or change claim is inferred from aggregate activity alone. The next contract must publish replay exclusions, matched quota coverage, uncertainty, and cohort support together.", "不会仅根据汇总活动推断社区容量或变化主张。下一版契约必须同时发布重放排除项、匹配额度覆盖率、不确定性和群组支持。", "No se infiere ninguna afirmación sobre capacidad o cambio comunitario solo a partir de actividad agregada. El próximo contrato debe publicar juntos exclusiones de reproducción, cobertura de cuota coincidente, incertidumbre y soporte de cohorte."],
  "community.weeklyActivity": ["Activity totals for the week above, from people who chose to contribute. A figure appears only when at least {count} different participants used that provider and model, and every figure is rounded down — so this is not everyone's usage, not an average, and not a cost.", "上周的活动总量来自选择贡献的人。只有当至少 {count} 位不同参与者使用了该提供商和模型时才会显示数值，并且所有数值都会向下取整——因此这不是每个人的使用情况、平均值或成本。", "Totales de actividad de la semana anterior, de personas que eligieron contribuir. Una cifra aparece solo cuando al menos {count} participantes diferentes usaron ese proveedor y modelo, y todas las cifras se redondean hacia abajo; por tanto, no es el uso de todas las personas, ni un promedio, ni un coste."],
  "community.partialMetrics": ["Some metrics were not released because their independent support was insufficient.", "部分指标因独立支持不足而未发布。", "Algunas métricas no se publicaron porque su soporte independiente fue insuficiente."],
  "community.providerAccountWeeklyActivity": ["Activity totals for the week above, from eligible contribution accounts. A figure appears only when at least {count} distinct eligible social-provider accounts used that provider and model, and every figure is rounded down — so this is not everyone's usage, not an average, and not a cost.", "上周的活动总量来自符合条件的贡献账户。只有当至少 {count} 个不同的符合条件的社交提供商账户使用了该提供商和模型时才会显示数值，并且所有数值都会向下取整——因此这不是每个人的使用情况、平均值或成本。", "Totales de actividad de la semana anterior, de cuentas de contribución elegibles. Una cifra aparece solo cuando al menos {count} cuentas elegibles y distintas de proveedores sociales usaron ese proveedor y modelo, y todas las cifras se redondean hacia abajo; por tanto, no es el uso de todas las personas, ni un promedio, ni un coste."],
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
  "community.currentReleaseScope": ["This release currently reports privacy-safe activity totals. Cohort weekly-limit estimates, matched quota coverage, replay exclusions, and change confidence require the next community contract before they can be shown honestly.", "此版本目前报告保护隐私的活动总量。群组每周限额估计、匹配额度覆盖率、重放排除项和变化置信度需要下一版社区契约后才能如实显示。", "Este lanzamiento informa actualmente totales de actividad seguros para la privacidad. Las estimaciones de límite semanal de cohorte, la cobertura de cuota coincidente, las exclusiones de reproducción y la confianza del cambio requieren el próximo contrato comunitario antes de poder mostrarse con honestidad."],
  "community.estimate.serviceUnavailable.label": ["Unavailable", "不可用", "No disponible"],
  "community.estimate.serviceUnavailable.hero": ["Unavailable right now", "当前不可用", "No disponible ahora"],
  "community.estimate.serviceUnavailable.body": ["The community service is temporarily unavailable, so there’s no estimate to show.", "社区服务暂时不可用，因此没有可显示的估计。", "El servicio comunitario no está disponible temporalmente, por lo que no hay una estimación que mostrar."],
  "community.estimate.developmentUnsafe.label": ["Unavailable", "不可用", "No disponible"],
  "community.estimate.developmentUnsafe.hero": ["No public estimate", "没有公开估计", "No hay estimación pública"],
  "community.estimate.developmentUnsafe.body": ["There’s no privacy-reviewed community estimate to show right now.", "目前没有经过隐私审查的社区估计可供显示。", "Ahora no hay una estimación comunitaria revisada por privacidad que mostrar."],
  "community.estimate.unsupportedSchema.label": ["Unavailable", "不可用", "No disponible"],
  "community.estimate.unsupportedSchema.hero": ["Estimate update required", "需要更新估计", "Se requiere actualizar la estimación"],
  "community.estimate.unsupportedSchema.body": ["This estimate needs an update before it can be shown safely.", "此估计需要更新后才能安全显示。", "Esta estimación necesita una actualización antes de poder mostrarse de forma segura."],
  "community.estimate.notYetPublished.label": ["Collecting evidence", "正在收集证据", "Recopilando evidencia"],
  "community.estimate.notYetPublished.hero": ["Collecting matched evidence", "正在收集匹配证据", "Recopilando evidencia coincidente"],
  "community.estimate.notYetPublished.body": ["The community estimate isn’t ready yet. Matched quota coverage and uncertainty are still being collected.", "社区估计尚未准备好。匹配额度覆盖率和不确定性仍在收集。", "La estimación comunitaria aún no está lista. Todavía se están recopilando la cobertura de cuota coincidente y la incertidumbre."],
  "community.estimate.withdrawn.label": ["Not published", "未发布", "No publicado"],
  "community.estimate.withdrawn.hero": ["This week was withdrawn", "本周已被撤回", "Esta semana fue retirada"],
  "community.estimate.withdrawn.body": ["This week’s estimate was withdrawn after privacy or quality review.", "本周的估计在隐私或质量审查后被撤回。", "La estimación de esta semana fue retirada tras una revisión de privacidad o calidad."],
  "community.estimate.suppressed.label": ["Not published", "未发布", "No publicado"],
  "community.estimate.suppressed.hero": ["Not published this week", "本周未发布", "No publicado esta semana"],
  "community.estimate.suppressed.body": ["This week’s estimate is not published because the evidence did not pass the required privacy checks.", "本周的估计未发布，因为证据未通过所需的隐私检查。", "La estimación de esta semana no se publica porque la evidencia no superó las comprobaciones de privacidad requeridas."],
  "community.estimate.activityOnly.label": ["Activity only", "仅活动", "Solo actividad"],
  "community.estimate.activityOnly.hero": ["Activity released; estimate pending", "活动已发布；估计待定", "Actividad publicada; estimación pendiente"],
  "community.estimate.activityOnly.body": ["This week’s community activity is available, but it does not support an allowance estimate yet.", "本周的社区活动可用，但尚不支持额度估计。", "La actividad comunitaria de esta semana está disponible, pero aún no admite una estimación de asignación."],
  "community.detailedActivity": ["View detailed activity by provider and model ({count} cells)", "按提供商和模型查看详细活动（{count} 个单元格）", "Ver actividad detallada por proveedor y modelo ({count} celdas)"],
  "community.metricsCaption": ["Privacy-safe delayed weekly community metrics", "保护隐私的延迟每周社区指标", "Métricas comunitarias semanales diferidas y seguras para la privacidad"],
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

export function translate(key, values = {}, locale = DEFAULT_LOCALE) {
  const row = WEB_MESSAGES[key];
  if (!row) return interpolate(key, values);
  const index = catalogIndex(negotiateLocale(locale));
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
  "Skip to monitoring dashboard": ["跳到监测仪表板", "Ir al panel de seguimiento"],
  "Community checking": ["正在检查社区", "Comprobando la comunidad"],
  "Connecting": ["正在连接", "Conectando"],
  "Analyze local usage": ["分析本地使用情况", "Analizar el uso local"],
  "Overview": ["概览", "Resumen"],
  "Allowance": ["额度", "Límite"],
  "Trends": ["趋势", "Tendencias"],
  "How it works": ["工作原理", "Cómo funciona"],
  "Community": ["社区", "Comunidad"],
  "Data & privacy": ["数据与隐私", "Datos y privacidad"],
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
  "On your computer": ["在你的电脑上", "En tu equipo"],
  "Included": ["包含", "Incluido"],
  "Excluded": ["排除", "Excluido"],
  "Identity": ["身份", "Identidad"],
  "Pseudonymous": ["假名化", "Seudónimo"],
  "Waiting": ["等待中", "En espera"],
  "Review contribution": ["审阅贡献", "Revisar contribución"],
  "Not now": ["暂不", "Ahora no"],
  "Automatic contribution": ["自动贡献", "Contribución automática"],
  "Off": ["关闭", "Desactivado"],
  "Prepare and review evidence": ["准备并审阅证据", "Preparar y revisar evidencia"],
  "Preparation identity": ["准备身份", "Identidad de preparación"],
  "24 hours": ["24 小时", "24 horas"],
  "7 days": ["7 天", "7 días"],
  "Choose a TiboTattle .json export": ["选择一个 TiboTattle .json 导出文件", "Elige una exportación .json de TiboTattle"],
  "Schema": ["架构", "Esquema"],
  "Exact bytes": ["确切字节数", "Bytes exactos"],
  "Usage rows": ["使用行", "Filas de uso"],
  "Quota rows": ["额度行", "Filas de cuota"],
  "Validate and contribute": ["验证并贡献", "Validar y contribuir"],
  "Contribution activity": ["贡献活动", "Actividad de contribución"],
  "In flight": ["传输中", "En curso"],
  "Accepted": ["已接受", "Aceptado"],
  "Needs attention": ["需要关注", "Requiere atención"],
  "Next attempt": ["下次尝试", "Siguiente intento"],
  "Last accepted": ["上次接受", "Último aceptado"],
  "Pause": ["暂停", "Pausar"],
  "Resume": ["恢复", "Reanudar"],
  "Verified": ["已验证", "Verificado"],
  "Database": ["数据库", "Base de datos"],
  "Deletion ledger": ["删除账本", "Registro de eliminaciones"],
  "Collection state": ["收集状态", "Estado de recopilación"],
  "Enrollment": ["注册", "Inscripción"],
  "User control": ["用户控制", "Control del usuario"],
  "Lifecycle enforcement": ["生命周期执行", "Aplicación del ciclo de vida"],
  "Contribution history": ["贡献历史", "Historial de contribuciones"],
  "Hosted privacy controls": ["托管隐私控制", "Controles de privacidad alojados"],
  "Delete all contributed metadata": ["删除所有已贡献的元数据", "Eliminar todos los metadatos aportados"],
  "Delayed community evidence": ["延迟社区证据", "Evidencia comunitaria diferida"],
  "Published weekly snapshot": ["已发布的每周快照", "Resumen semanal publicado"],
  "Snapshot": ["快照", "Resumen"],
  "Mac app": ["Mac 应用", "App para Mac"],
  "FAQ": ["常见问题", "Preguntas frecuentes"],
  "Mac app availability": ["Mac 应用可用性", "Disponibilidad de la app para Mac"],
  "See the snapshot": ["查看快照", "Ver el resumen"],
  "Privacy-safe community snapshot": ["隐私安全的社区快照", "Resumen comunitario seguro para la privacidad"],
  "Delayed community evidence": ["延迟社区证据", "Evidencia comunitaria diferida"],
  "Signed Mac installer": ["已签名的 Mac 安装程序", "Instalador de Mac firmado"],
  "Download for Mac": ["下载 Mac 版", "Descargar para Mac"],
  "Choose what to share": ["选择要分享的内容", "Elige qué compartir"],
  "Local-first by design": ["本地优先设计", "Local primero por diseño"],
  "TiboTattle · Private usage visibility for Mac": ["TiboTattle · 面向 Mac 的私密使用情况可见性", "TiboTattle · Visibilidad privada de uso para Mac"],
  "Skip to TiboTattle": ["跳到 TiboTattle", "Ir a TiboTattle"],
  "Docs": ["文档", "Documentación"],
  "Release status": ["发布状态", "Estado de la versión"],
  "Understand your Codex week.": ["了解你的 Codex 一周。", "Entiende tu semana de Codex."],
  "TiboTattle is a local-first Mac app for understanding personal Codex usage. It estimates your seven-day allowance in API-equivalent terms, with a clear history kept on your Mac.": ["TiboTattle 是一款本地优先的 Mac 应用，用于了解个人 Codex 使用情况。它以 API 等价值估算你的七天额度，并在你的 Mac 上保留清晰的历史记录。", "TiboTattle es una app para Mac que prioriza lo local y ayuda a entender tu uso personal de Codex. Estima tu límite de siete días en términos equivalentes de API y conserva un historial claro en tu Mac."],
  "Download for macOS": ["下载 macOS 版", "Descargar para macOS"],
  "Already installed?": ["已经安装？", "¿Ya está instalada?"],
  "Open TiboTattle": ["打开 TiboTattle", "Abrir TiboTattle"],
  "Signed release coming soon.": ["已签名版本即将推出。", "Próximamente habrá una versión firmada."],
  "Community seven-day estimate": ["社区七天额度估计", "Estimación comunitaria de siete días"],
  "Checking evidence": ["正在检查证据", "Comprobando la evidencia"],
  "Demo data": ["演示数据", "Datos de demostración"],
  "Seven-day allowance estimate": ["七天额度估计", "Estimación de asignación de siete días"],
  "$1,879": ["$1,879", "$1,879"],
  "per 7 days": ["每 7 天", "por 7 días"],
  "Example only — not your usage or a bill.": ["仅作示例 — 不是你的使用情况或账单。", "Solo es un ejemplo; no es tu uso ni una factura."],
  "Observed resets": ["已观测到的重置", "Restablecimientos observados"],
  "Allowance remaining": ["剩余额度", "Asignación restante"],
  "61%": ["61%", "61%"],
  "Your dashboard is calculated privately on your Mac.": ["你的仪表板会在 Mac 上私密计算。", "Tu panel se calcula de forma privada en tu Mac."],
  "Seven-day view": ["七天视图", "Vista de siete días"],
  "See the estimate and its history across observed resets.": ["查看估计值及其在已观测重置间的历史记录。", "Consulta la estimación y su historial entre restablecimientos observados."],
  "Local by default": ["默认保留在本地", "Local de forma predeterminada"],
  "Your dashboard stays on your Mac. Community contribution is optional.": ["你的仪表板保留在 Mac 上。是否贡献给社区由你决定。", "Tu panel permanece en tu Mac. La contribución a la comunidad es opcional."],
  "Evidence, not guesses": ["基于证据，而非猜测", "Evidencia, no conjeturas"],
  "Missing or weak evidence stays visibly unknown.": ["缺失或薄弱的证据会明确显示为未知。", "La evidencia ausente o débil permanece visiblemente desconocida."],
  "Published only when delayed, aggregate evidence passes privacy and quality checks.": ["仅当延迟的汇总证据通过隐私和质量检查时才会发布。", "Se publica solo cuando la evidencia agregada y diferida supera las comprobaciones de privacidad y calidad."],
  "Checking whether matched evidence supports a public estimate…": ["正在检查匹配证据是否支持公开估计…", "Comprobando si la evidencia coincidente respalda una estimación pública…"],
  "How community estimates work": ["社区估计的工作方式", "Cómo funcionan las estimaciones comunitarias"],
  "Community activity": ["社区活动", "Actividad comunitaria"],
  "Shown separately from the seven-day estimate.": ["与七天估计分开显示。", "Se muestra por separado de la estimación de siete días."],
  "Privacy and source details": ["隐私和来源详情", "Detalles de privacidad y fuente"],
  "Each eligible contribution account is capped, and weekly figures are delayed, rounded, and shown only when enough eligible provider accounts support them.": ["每个符合条件的贡献账户都有上限；每周数值会延迟、取整，并且仅在有足够符合条件的提供商账户支持时显示。", "Cada cuenta de contribución elegible tiene un límite y las cifras semanales se retrasan, se redondean y solo se muestran cuando las respaldan suficientes cuentas de proveedor elegibles."],
  "Local-first and independent. Not affiliated with OpenAI.": ["本地优先且独立。与 OpenAI 无关。", "Local e independiente. Sin afiliación con OpenAI."],
  "GitHub": ["GitHub", "GitHub"],
  "X": ["X", "X"],
  "Turn on JavaScript to check the latest download and community estimate.": ["启用 JavaScript 以查看最新下载和社区估计。", "Activa JavaScript para consultar la última descarga y la estimación comunitaria."],
  "Skip to the community snapshot": ["跳到社区快照", "Ir al resumen comunitario"],
  "Private usage visibility for Mac": ["面向 Mac 的私密使用情况可见性", "Visibilidad privada de uso para Mac"],
  "Know what your Codex week is doing.": ["了解你的 Codex 一周使用情况。", "Conoce qué está ocurriendo en tu semana de Codex."],
  "TiboTattle is a local-first Mac app that reads content-free usage and quota metadata on your Mac. Your personal dashboard stays in the app; this site only publishes the delayed, privacy-safe view that contributors chose to share.": ["TiboTattle 是一款本地优先的 Mac 应用，会在你的 Mac 上读取不含内容的使用情况和额度元数据。你的个人仪表板保留在应用内；本网站只发布贡献者选择分享的、经过延迟处理且保护隐私的视图。", "TiboTattle es una app para Mac que prioriza lo local y lee metadatos de uso y cuota sin contenido en tu Mac. Tu panel personal permanece en la app; este sitio solo publica la vista diferida y segura para la privacidad que los colaboradores eligieron compartir."],
  "A seven-day view, shared carefully.": ["谨慎分享的七天视图。", "Una vista de siete días, compartida con cuidado."],
  "This page shows delayed, privacy-safe weekly activity from opt-in contributors — not your personal usage, quota, or cost.": ["本页展示自愿贡献者经过延迟处理且保护隐私的每周活动，而不是你的个人使用情况、额度或成本。", "Esta página muestra actividad semanal diferida y segura para la privacidad de colaboradores que aceptaron participar, no tu uso, cuota ni coste personal."],
  "A community seven-day allowance estimate will appear only after enough matched quota evidence exists; it is not published today.": ["只有在存在足够匹配的额度证据后，才会显示社区七天额度估计；今天尚未发布。", "Una estimación comunitaria del límite de siete días solo aparecerá cuando exista suficiente evidencia de cuota coincidente; hoy no se publica."],
  "Seven-day community snapshot": ["七天社区快照", "Resumen comunitario de siete días"],
  "Checking snapshot": ["正在检查快照", "Comprobando el resumen"],
  "Checking for the latest delayed weekly snapshot…": ["正在检查最新的延迟每周快照…", "Comprobando el último resumen semanal diferido…"],
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
  "Only reviewed aggregates appear.": ["只显示经过审核的汇总数据。", "Solo aparecen agregados revisados."],
  "The public view is delayed and support-gated. Released metrics are clipped per participant, rounded down, and may show a status instead of a value when support is insufficient.": ["公开视图经过延迟处理并受支持门槛限制。已发布指标按参与者截断并向下取整；当支持不足时，可能显示状态而非数值。", "La vista pública se retrasa y está sujeta a un umbral de soporte. Las métricas publicadas se recortan por participante, se redondean hacia abajo y pueden mostrar un estado en lugar de un valor cuando el soporte es insuficiente."],
  "A few useful boundaries": ["几个重要边界", "Algunos límites útiles"],
  "Can this website show my personal usage?": ["这个网站能显示我的个人使用情况吗？", "¿Puede este sitio web mostrar mi uso personal?"],
  "No. Your personal dashboard is a Mac-app surface backed by the local loopback companion. This page only requests the public community snapshot endpoint.": ["不能。你的个人仪表板是由本地回环伴随程序支持的 Mac 应用界面。本页只请求公开的社区快照端点。", "No. Tu panel personal es una superficie de la app para Mac respaldada por el acompañante de bucle local. Esta página solo solicita el punto de conexión público del resumen comunitario."],
  "What do the published numbers mean?": ["已发布的数字代表什么？", "¿Qué significan los números publicados?"],
  "They are delayed activity totals from contributors, clipped per participant and rounded down. A cell can instead show a release status. They are not a community allowance or best estimate.": ["它们是来自贡献者的延迟活动总数，按参与者截断并向下取整。单元格也可能显示发布状态。它们不是社区额度或最佳估计。", "Son totales de actividad diferida de colaboradores, recortados por participante y redondeados hacia abajo. Una celda puede mostrar en su lugar un estado de publicación. No son un límite comunitario ni la mejor estimación."],
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
  "One dot per distinct reset.": ["每个不同的重置对应一个点。", "Un punto por cada reinicio distinto."],
  "Historical median estimate": ["历史中位数估计", "Estimación mediana histórica"],
  "No evidence interval available": ["没有可用的证据区间", "No hay intervalo de evidencia disponible"],
  "The estimate will appear when local usage can be matched to quota changes.": ["当本地使用情况可与额度变化匹配时，将显示估计值。", "La estimación aparecerá cuando el uso local pueda coincidir con cambios de cuota."],
  "Price basis for the visible fits": ["可见拟合的价格依据", "Base de precios para los ajustes visibles"],
  "Price table not yet loaded": ["价格表尚未加载", "La tabla de precios todavía no se ha cargado"],
  "TiboTattle will state which reviewed price table was used once local evidence loads.": ["本地证据加载后，TiboTattle 将说明使用了哪个经过审核的价格表。", "TiboTattle indicará qué tabla de precios revisada se usó cuando se cargue la evidencia local."],
  "Allowance estimate history": ["额度估计历史", "Historial de estimaciones de límite"],
  "All": ["全部", "Todo"],
  "Typical estimate": ["典型估计", "Estimación típica"],
  "Observed across 50+ points": ["在 50 多个点中观测到", "Observado en más de 50 puntos"],
  "Short observation": ["短时观测", "Observación breve"],
  "No weekly estimates loaded.": ["未加载每周估计。", "No se cargaron estimaciones semanales."],
  "Each dot is a separate reset estimate. Its vertical bar shows the range supported by that reset’s observations.": ["每个点都是单独的重置估计。其竖条显示该重置的观测结果所支持的范围。", "Cada punto es una estimación de reinicio independiente. Su barra vertical muestra el rango respaldado por las observaciones de ese reinicio."],
  "See individual measurements": ["查看单独测量值", "Ver mediciones individuales"],
  "Individual seven-day reset estimates": ["单独的七天重置估计", "Estimaciones individuales de reinicio de siete días"],
  "Observed span": ["观测跨度", "Intervalo observado"],
  "Measured range": ["测量范围", "Rango medido"],
  "No weekly evidence loaded.": ["未加载每周证据。", "No se cargó evidencia semanal."],
  "03 · Timeline": ["03 · 时间线", "03 · Cronología"],
  "Usage and allowance over time": ["随时间变化的使用情况和额度", "Uso y límite a lo largo del tiempo"],
  "API-price-equivalent usage over time": ["随时间变化的 API 价格等值使用情况", "Uso equivalente al precio de API a lo largo del tiempo"],
  "Replay-safe local increments · browser-local time · event-time historical API cards": ["可重放安全的本地增量 · 浏览器本地时间 · 事件时间的历史 API 卡片", "Incrementos locales seguros para reproducción · hora local del navegador · tarjetas históricas de API según la hora del evento"],
  "API-cost estimate": ["API 成本估计", "Estimación de coste de API"],
  "7-day allowance remaining": ["剩余七天额度", "Límite de 7 días restante"],
  "No real usage timeline loaded": ["未加载真实使用时间线", "No se cargó una cronología de uso real"],
  "Analyze local usage to build recent content-free usage buckets.": ["分析本地使用情况以构建最近的不含内容的使用分组。", "Analiza el uso local para generar grupos recientes de uso sin contenido."],
  "Advanced calibration: measured quota change versus calculated change": ["高级校准：实测额度变化与计算变化", "Calibración avanzada: cambio de cuota medido frente a cambio calculado"],
  "Observed quota change versus cost-implied change": ["观测到的额度变化与成本推算的变化", "Cambio de cuota observado frente a cambio implícito por el coste"],
  "Browser-local chart axis · exact local and UTC times are listed below": ["浏览器本地时间轴 · 下方列出了精确的本地和 UTC 时间", "Eje del gráfico según el navegador · las horas locales y UTC exactas se muestran abajo"],
  "Calibration window": ["校准窗口", "Ventana de calibración"],
  "15 min": ["15 分钟", "15 min"],
  "1 hour": ["1 小时", "1 hora"],
  "3 hours": ["3 小时", "3 horas"],
  "Observed quota": ["观测到的额度", "Cuota observada"],
  "Expected from API cost": ["根据 API 成本推算", "Esperado según el coste de API"],
  "Missing quota bracket": ["缺少额度区间", "Falta el tramo de cuota"],
  "Reset or track change": ["重置或轨迹变化", "Reinicio o cambio de trayectoria"],
  "Ambiguous movement": ["变化不明确", "Movimiento ambiguo"],
  "No timeline loaded": ["未加载时间线", "No se cargó ninguna cronología"],
  "Connect the local companion or choose the labeled demo.": ["连接本地伴随程序或选择带标签的演示。", "Conecta el acompañante local o elige la demostración etiquetada."],
  "Where the estimate misses": ["估计偏差的位置", "Dónde falla la estimación"],
  "Residual = observed quota change minus cost-implied change. Positive values mean the allowance fell faster than the token model predicted. The axis covers the same date range as the calibration chart above; windows that cannot be differenced are shaded gaps, never zeros.": ["残差 = 观测到的额度变化减去成本推算的变化。正值表示额度下降得比令牌模型预测的更快。该轴覆盖与上方校准图相同的日期范围；无法求差的窗口会显示为阴影间隙，绝不是零。", "Residual = cambio de cuota observado menos cambio implícito por el coste. Los valores positivos significan que el límite cayó más rápido de lo que predijo el modelo de tokens. El eje cubre el mismo intervalo de fechas que el gráfico de calibración anterior; las ventanas que no se pueden diferenciar son huecos sombreados, nunca ceros."],
  "No residual evidence loaded.": ["未加载残差证据。", "No se cargó evidencia de residuales."],
  "Inspect exact periods": ["检查精确期间", "Inspeccionar períodos exactos"],
  "Exact windows and evidence state": ["精确窗口和证据状态", "Ventanas exactas y estado de evidencia"],
  "Largest unexplained quota movement periods": ["最大的未解释额度变化期间", "Períodos con mayor movimiento de cuota sin explicación"],
  "Exact local / UTC time": ["精确本地 / UTC 时间", "Hora local / UTC exacta"],
  "Evidence state": ["证据状态", "Estado de evidencia"],
  "No periods loaded.": ["未加载期间。", "No se cargaron períodos."],
  "7d": ["7 天", "7 días"],
  "31d": ["31 天", "31 días"],
  "24h": ["24 小时", "24 h"],
  "04 · Cost accounting": ["04 · 成本核算", "04 · Contabilidad de costes"],
  "How the estimate was calculated": ["估计的计算方式", "Cómo se calculó la estimación"],
  "30d": ["30 天", "30 días"],
  "API pricing is a measuring stick, not your bill.": ["API 定价是衡量标尺，不是你的账单。", "Los precios de API son una regla de medida, no tu factura."],
  "Every local usage increment is repriced with the public Standard API rate card, then multiplied by the published Fast credit rate when its effective mode is Fast. The result is a quota-weighted API-price equivalent, not an invoice.": ["每个本地使用增量都会按公开的 Standard API 费率卡重新定价；当其有效模式为 Fast 时，再乘以公开的 Fast 抵扣费率。结果是按额度加权的 API 价格等值，而不是账单。", "Cada incremento de uso local se vuelve a valorar con la tarjeta pública de tarifas Standard API y luego se multiplica por la tasa publicada de crédito Fast cuando su modo efectivo es Fast. El resultado es un equivalente de precio de API ponderado por cuota, no una factura."],
  "Token components": ["令牌组成", "Componentes de tokens"],
  "Token count": ["令牌数量", "Recuento de tokens"],
  "Every measured token belongs to one non-overlapping component. Output text excludes reasoning tokens; combined output is only used when a source does not provide that split.": ["每个测量到的令牌只属于一个不重叠的组成部分。输出文本不包括推理令牌；只有在来源未提供该拆分时才使用合并输出。", "Cada token medido pertenece a un componente no superpuesto. El texto de salida excluye los tokens de razonamiento; la salida combinada solo se usa cuando una fuente no proporciona esa división."],
  "Cost contribution": ["成本贡献", "Contribución al coste"],
  "API-equivalent cost": ["API 等值成本", "Coste equivalente de API"],
  "Standard-rate API equivalent by component. Tokens with no mapped price remain visible in the count, but do not add a guessed cost.": ["按组成部分计算的标准费率 API 等值。没有映射价格的令牌仍会显示在计数中，但不会加入猜测的成本。", "Equivalente de API de tarifa estándar por componente. Los tokens sin precio asignado permanecen visibles en el recuento, pero no añaden un coste estimado."],
  "Models": ["模型", "Modelos"],
  "Recognized and unknown model usage": ["已识别和未知模型使用情况", "Uso de modelos reconocidos y desconocidos"],
  "Replay-safe usage grouped by recognized model": ["按已识别模型分组的可重放安全使用情况", "Uso seguro para reproducción agrupado por modelo reconocido"],
  "Model": ["模型", "Modelo"],
  "Usage increments": ["使用增量", "Incrementos de uso"],
  "Tokens": ["令牌", "Tokens"],
  "API equivalent": ["API 等值", "Equivalente de API"],
  "Any unrecognized model is kept as an explicit overflow row. Its tokens remain visible, but no price is invented.": ["任何未识别模型都会保留为显式溢出行。其令牌仍然可见，但不会编造价格。", "Cualquier modelo no reconocido se conserva como una fila explícita de desbordamiento. Sus tokens siguen visibles, pero no se inventa ningún precio."],
  "05 · Reading the estimate": ["05 · 解读估计", "05 · Interpretar la estimación"],
  "When to treat this as an estimate": ["何时应将其视为估计", "Cuándo tratar esto como una estimación"],
  "TiboTattle shows only the few conditions that materially affect the allowance estimate. Everything else stays in local diagnostics.": ["TiboTattle 只显示会实质性影响额度估计的少数条件。其余内容保留在本地诊断中。", "TiboTattle solo muestra las pocas condiciones que afectan materialmente a la estimación del límite. Todo lo demás permanece en diagnósticos locales."],
  "What could change this estimate": ["什么可能改变此估计", "Qué podría cambiar esta estimación"],
  "No quality artifact loaded.": ["未加载质量工件。", "No se cargó ningún artefacto de calidad."],
  "Share one anonymous summary": ["分享一份匿名摘要", "Comparte un resumen anónimo"],
  "Improve community estimates with one reviewed, content-free result. You see the exact prepared export before anything is sent.": ["用一份经过审核且不含内容的结果改进社区估计。在发送任何内容前，你可以查看确切的准备导出。", "Mejora las estimaciones comunitarias con un resultado revisado y sin contenido. Ves la exportación preparada exacta antes de que se envíe nada."],
  "What leaves this Mac — and what never does": ["什么会离开这台 Mac，以及什么永远不会", "Qué sale de este Mac y qué no sale nunca"],
  "May be shared: timestamps, token counts, safe model labels, coarse tool and surface categories, and observed allowance percentages.": ["可能被分享：时间戳、令牌计数、安全模型标签、粗略的工具和界面类别，以及观测到的额度百分比。", "Se pueden compartir: marcas de tiempo, recuentos de tokens, etiquetas de modelo seguras, categorías generales de herramientas y superficies, y porcentajes de límite observados."],
  "Never shared: prompts, responses, reasoning, files, paths, URLs, commands, account names, email addresses, identifiers, or credentials.": ["绝不会分享：提示词、回复、推理、文件、路径、URL、命令、帐户名称、电子邮件地址、标识符或凭据。", "Nunca se comparten: indicaciones, respuestas, razonamiento, archivos, rutas, URL, comandos, nombres de cuenta, direcciones de correo electrónico, identificadores ni credenciales."],
  "Sign in for hosted contribution": ["登录以进行托管贡献", "Inicia sesión para una contribución alojada"],
  "Not signed in": ["未登录", "Sin sesión iniciada"],
  "Hosted participation requires signing in with Google or Apple. The service stores only an irreversible hash of that sign-in — never your email or name — and this page keeps the sign-in token in memory only. Local-only use needs no account.": ["托管参与需要使用 Google 或 Apple 登录。服务只存储该登录的不可逆哈希值，绝不存储你的电子邮件或姓名；此页面只在内存中保留登录令牌。仅本地使用不需要帐户。", "La participación alojada requiere iniciar sesión con Google o Apple. El servicio solo almacena un hash irreversible de ese inicio de sesión, nunca tu correo electrónico ni tu nombre, y esta página conserva el token de inicio de sesión solo en memoria. El uso exclusivamente local no requiere cuenta."],
  "Sign in with Google": ["使用 Google 登录", "Iniciar sesión con Google"],
  "Sign in with Apple": ["使用 Apple 登录", "Iniciar sesión con Apple"],
  "Signed in with Google": ["已使用 Google 登录", "Sesión iniciada con Google"],
  "Signing out only forgets this sign-in on this page. It deletes nothing: metadata already contributed stays until you delete it in Hosted privacy controls.": ["退出登录只会让此页面忘记这次登录。它不会删除任何内容：已经贡献的元数据会一直保留，直到你在“托管隐私控制”中删除它。", "Cerrar sesión solo olvida este inicio de sesión en esta página. No elimina nada: los metadatos ya aportados permanecen hasta que los elimines en Controles de privacidad alojados."],
  "Sign out": ["退出登录", "Cerrar sesión"],
  "Check sign-in": ["检查登录状态", "Comprobar inicio de sesión"],
  "Cancel sign-in": ["取消登录", "Cancelar inicio de sesión"],
  "Hosted sign-in is not configured for this build.": ["此构建未配置托管登录。", "El inicio de sesión alojado no está configurado para esta compilación."],
  "Hosted Apple sign-in is not configured for this build.": ["此构建未配置托管 Apple 登录。", "El inicio de sesión alojado con Apple no está configurado para esta compilación."],
  "I consent to review and submit this metadata.": ["我同意审阅并提交这些元数据。", "Doy mi consentimiento para revisar y enviar estos metadatos."],
  "The result is shown for review before anything is sent.": ["在发送任何内容前会显示结果供审阅。", "El resultado se muestra para su revisión antes de enviar nada."],
  "Automatic contribution (advanced)": ["自动贡献（高级）", "Contribución automática (avanzado)"],
  "Off until you explicitly consent. No daemon or login item is installed; checks run only while TiboTattle is open.": ["在你明确同意前保持关闭。不会安装守护进程或登录项；检查只会在 TiboTattle 打开时运行。", "Desactivado hasta que des tu consentimiento explícito. No se instala ningún demonio ni elemento de inicio de sesión; las comprobaciones solo se ejecutan mientras TiboTattle está abierto."],
  "Turn off automatic contribution": ["关闭自动贡献", "Desactivar la contribución automática"],
  "06 · Data & privacy": ["06 · 数据与隐私", "06 · Datos y privacidad"],
  "Local by default. Contribute by choice.": ["默认本地处理。自主选择贡献。", "Local de forma predeterminada. Contribuye por elección."],
  "Raw logs are read by the loopback companion, not the webpage. A contribution must be a privacy-stripped export and is validated again by the server. Hosted participation requires signing in with Google or Apple; the service stores only an irreversible hash of that sign-in, never your email or name. Local-only use needs no account.": ["原始日志由回环伴随程序读取，而不是网页。贡献必须是移除了隐私内容的导出，并会由服务器再次验证。托管参与需要使用 Google 或 Apple 登录；服务只存储该登录的不可逆哈希值，绝不存储你的电子邮件或姓名。仅本地使用不需要帐户。", "Los registros sin procesar los lee el acompañante de bucle local, no la página web. Una contribución debe ser una exportación sin datos privados y el servidor la valida de nuevo. La participación alojada requiere iniciar sesión con Google o Apple; el servicio solo almacena un hash irreversible de ese inicio de sesión, nunca tu correo electrónico ni tu nombre. El uso exclusivamente local no requiere cuenta."],
  "Raw Codex logs": ["原始 Codex 日志", "Registros de Codex sin procesar"],
  "Prompts, responses, paths never enter this page": ["提示词、回复和路径绝不会进入此页面", "Las indicaciones, respuestas y rutas nunca entran en esta página"],
  "Loopback only": ["仅回环", "Solo bucle local"],
  "Reads logs, prices usage, builds safe summaries": ["读取日志、计算使用成本、构建安全摘要", "Lee registros, valora el uso y crea resúmenes seguros"],
  "Validated contribution": ["已验证的贡献", "Contribución validada"],
  "Content-free schema, bounded size, explicit consent": ["不含内容的架构、有界大小、明确同意", "Esquema sin contenido, tamaño limitado y consentimiento explícito"],
  "Pre-upload inspection": ["上传前检查", "Inspección previa a la carga"],
  "Exact metadata categories a contribution may contain": ["贡献可能包含的确切元数据类别", "Categorías exactas de metadatos que puede contener una contribución"],
  "Closed schema": ["封闭架构", "Esquema cerrado"],
  "Permitted metadata": ["允许的元数据", "Metadatos permitidos"],
  "Observation, event and reset timestamps": ["观测、事件和重置时间戳", "Marcas de tiempo de observación, evento y reinicio"],
  "Uncached input, cached input, cache write, text output, reasoning output and combined-output token counts": ["未缓存输入、缓存输入、缓存写入、文本输出、推理输出和合并输出令牌计数", "Recuentos de tokens de entrada sin caché, entrada en caché, escritura de caché, salida de texto, salida de razonamiento y salida combinada"],
  "Recognized model declaration or safe opaque model fingerprint": ["已识别模型声明或安全的不透明模型指纹", "Declaración de modelo reconocido o huella de modelo opaca y segura"],
  "Subscription speed and separately observed API service tier": ["订阅速度和单独观测的 API 服务层级", "Velocidad de suscripción y nivel de servicio de API observado por separado"],
  "Coarse surface, agent scope and child-rollout lineage classes": ["粗略的界面、代理范围和子运行谱系类别", "Clases generales de superficie, alcance de agente y linaje de ejecuciones secundarias"],
  "Coarse tool-class counts": ["粗略的工具类别计数", "Recuentos generales por clase de herramienta"],
  "Quota percentage, window duration, slot and reset timing": ["额度百分比、窗口持续时间、时段和重置时间", "Porcentaje de cuota, duración de ventana, franja y momento de reinicio"],
  "Domain-separated participant, account, session, event and snapshot pseudonyms where the selected contract permits them": ["在所选契约允许的情况下，使用域隔离的参与者、帐户、会话、事件和快照假名", "Seudónimos con separación de dominios para participante, cuenta, sesión, evento e instantánea cuando el contrato seleccionado lo permita"],
  "Schema, pricing, parser and consent provenance plus fixed diagnostics": ["架构、定价、解析器和同意来源以及固定诊断", "Procedencia de esquema, precios, analizador y consentimiento, además de diagnósticos fijos"],
  "Never collected or uploaded": ["绝不收集或上传", "Nunca se recopila ni se carga"],
  "Prompts, responses or reasoning text": ["提示词、回复或推理文本", "Indicaciones, respuestas o texto de razonamiento"],
  "Tool names, arguments, commands or command output": ["工具名称、参数、命令或命令输出", "Nombres de herramientas, argumentos, comandos o salida de comandos"],
  "URLs, files, paths, repositories, branches or working directories": ["URL、文件、路径、仓库、分支或工作目录", "URL, archivos, rutas, repositorios, ramas o directorios de trabajo"],
  "Email addresses, account names, hostnames or usernames": ["电子邮件地址、帐户名称、主机名或用户名", "Direcciones de correo electrónico, nombres de cuenta, nombres de host o nombres de usuario"],
  "Raw participant, device, account, session or request identifiers": ["原始参与者、设备、帐户、会话或请求标识符", "Identificadores sin procesar de participante, dispositivo, cuenta, sesión o solicitud"],
  "Credentials, cookies, API keys, tokens or authorization material": ["凭据、Cookie、API 密钥、令牌或授权材料", "Credenciales, cookies, claves de API, tokens o material de autorización"],
  "Arbitrary labels, unknown fields or free-form metadata": ["任意标签、未知字段或自由格式元数据", "Etiquetas arbitrarias, campos desconocidos o metadatos de formato libre"],
  "Browser validation is a preflight. The Worker decrypts into bounded memory, validates the same closed schema again, rejects content canaries, and recalculates API-price-equivalent values before D1 ingestion.": ["浏览器验证是预检。Worker 会在有界内存中解密，再次验证同一封闭架构，拒绝内容金丝雀，并在写入 D1 前重新计算 API 价格等值。", "La validación del navegador es una comprobación previa. El Worker descifra en memoria limitada, valida de nuevo el mismo esquema cerrado, rechaza canarios de contenido y recalcula valores equivalentes al precio de API antes de la ingesta en D1."],
  "Advanced details": ["高级详情", "Detalles avanzados"],
  "Contribution, service, and account controls": ["贡献、服务和帐户控制", "Controles de contribución, servicio y cuenta"],
  "Closed until you choose it": ["在你选择前保持关闭", "Cerrado hasta que lo elijas"],
  "Local collector": ["本地收集器", "Recopilador local"],
  "Source and analysis status": ["来源和分析状态", "Estado de la fuente y del análisis"],
  "Unknown": ["未知", "Desconocido"],
  "Last analysis": ["上次分析", "Último análisis"],
  "Safe records": ["安全记录", "Registros seguros"],
  "Source bytes": ["来源字节数", "Bytes de origen"],
  "Not exposed to browser": ["未暴露给浏览器", "No expuesto al navegador"],
  "Analyzing recent local history": ["正在分析最近的本地历史", "Analizando el historial local reciente"],
  "The local companion has not started a bounded local analysis.": ["本地伴随程序尚未开始有界的本地分析。", "El acompañante local no ha iniciado un análisis local limitado."],
  "Raw log contents and source paths never enter this page.": ["原始日志内容和来源路径绝不会进入此页面。", "El contenido de los registros sin procesar y las rutas de origen nunca entran en esta página."],
  "You may close this browser tab while analysis continues. Keep the TiboTattle app open; closing it ends the local companion and preserves the last durable checkpoint for a later resume.": ["分析继续时你可以关闭此浏览器标签页。请保持 TiboTattle 应用打开；关闭它会结束本地伴随程序，并保留最近的持久检查点以便稍后继续。", "Puedes cerrar esta pestaña del navegador mientras continúa el análisis. Mantén abierta la app TiboTattle; cerrarla finaliza el acompañante local y conserva el último punto de control persistente para reanudar más tarde."],
  "Timestamps and models": ["时间戳和模型", "Marcas de tiempo y modelos"],
  "Token components and quota observations": ["令牌组成和额度观测", "Componentes de tokens y observaciones de cuota"],
  "Coarse tool and surface categories": ["粗略的工具和界面类别", "Categorías generales de herramientas y superficies"],
  "Prompts and responses": ["提示词和回复", "Indicaciones y respuestas"],
  "Files, paths, commands and arguments": ["文件、路径、命令和参数", "Archivos, rutas, comandos y argumentos"],
  "Email and account names": ["电子邮件和帐户名称", "Correos electrónicos y nombres de cuenta"],
  "Review before the first send": ["首次发送前审阅", "Revisar antes del primer envío"],
  "Review a content-free contribution": ["审阅一份不含内容的贡献", "Revisar una contribución sin contenido"],
  "Checking service": ["正在检查服务", "Comprobando el servicio"],
  "Preparation reads the latest bounded interval locally and performs no upload. Inspect the concise summary, expand the exact JSON if wanted, then confirm the first send.": ["准备会在本地读取最新的有界区间，并且不会上传。检查简明摘要，如有需要展开确切的 JSON，然后确认首次发送。", "La preparación lee localmente el intervalo limitado más reciente y no realiza ninguna carga. Inspecciona el resumen conciso, expande el JSON exacto si lo deseas y luego confirma el primer envío."],
  "Checking": ["正在检查", "Comprobando"],
  "Evidence to prepare": ["待准备的证据", "Evidencia que preparar"],
  "Analyze local usage to estimate the number of privacy-safe records and upload batches before preparation.": ["在准备前分析本地使用情况，以估计保护隐私的记录数和上传批次数。", "Analiza el uso local para estimar el número de registros seguros para la privacidad y lotes de carga antes de la preparación."],
  "Prepare and review last 24 hours": ["准备并审阅最近 24 小时", "Preparar y revisar las últimas 24 horas"],
  "Nothing is sent until you separately inspect and choose a send action. A dense seven-day selection may exceed the single reviewed-set safety cap; if so, choose 24 hours instead.": ["在你单独检查并选择发送操作前，不会发送任何内容。密集的七天选择可能超过单个已审阅集合的安全上限；如发生这种情况，请改选 24 小时。", "No se envía nada hasta que inspecciones por separado y elijas una acción de envío. Una selección densa de siete días puede superar el límite de seguridad de un solo conjunto revisado; si ocurre, elige 24 horas."],
  "Advanced: use an existing TiboTattle export": ["高级：使用现有的 TiboTattle 导出", "Avanzado: usar una exportación existente de TiboTattle"],
  "Choose a": ["选择一个", "Elige un"],
  ".json": [".json", ".json"],
  "file created by TiboTattle. Do not choose a": ["由 TiboTattle 创建的文件。不要选择", "archivo creado por TiboTattle. No elijas un"],
  ".jsonl": [".jsonl", ".jsonl"],
  "file, a sessions folder, or a raw Codex log.": ["文件、sessions 文件夹或原始 Codex 日志。", "archivo, una carpeta sessions ni un registro de Codex sin procesar."],
  "Not a Codex log or .jsonl file · 1.25 MB browser validation limit": ["不是 Codex 日志或 .jsonl 文件 · 浏览器验证上限为 1.25 MB", "No es un registro de Codex ni un archivo .jsonl · límite de validación del navegador de 1,25 MB"],
  "Selected export inspection": ["选定导出检查", "Inspección de la exportación seleccionada"],
  "Exact retained fields and values": ["确切保留的字段和值", "Campos y valores exactos conservados"],
  "Not validated": ["未验证", "No validado"],
  "Choose a TiboTattle export to validate it locally.": ["选择一个 TiboTattle 导出以在本地验证它。", "Elige una exportación de TiboTattle para validarla localmente."],
  "Review every validated field and value": ["审阅每个已验证的字段和值", "Revisar cada campo y valor validado"],
  "This is the complete plaintext contribution. These exact values are encrypted in your browser; raw logs and any field not shown here are not sent.": ["这是完整的明文贡献。这些确切值会在你的浏览器中加密；原始日志和此处未显示的任何字段都不会发送。", "Esta es la contribución completa en texto sin cifrar. Estos valores exactos se cifran en tu navegador; no se envían los registros sin procesar ni ningún campo que no se muestre aquí."],
  "I reviewed this as a privacy-safe TiboTattle export.": ["我已将其作为保护隐私的 TiboTattle 导出进行了审阅。", "He revisado esto como una exportación de TiboTattle segura para la privacidad."],
  "Uploading is optional and can be tested against a local backend.": ["上传是可选的，并且可针对本地后端进行测试。", "La carga es opcional y se puede probar con un backend local."],
  "Advanced queue and exact review": ["高级队列和精确审阅", "Cola avanzada y revisión exacta"],
  "Checking queue": ["正在检查队列", "Comprobando la cola"],
  "The local queue contains metadata about committed, privacy-verified batches only. It never contains prompts, responses, source paths, account names, browser sessions, or device secrets.": ["本地队列仅包含已提交且经过隐私验证的批次元数据。它绝不包含提示词、回复、来源路径、帐户名称、浏览器会话或设备机密。", "La cola local contiene solo metadatos sobre lotes confirmados y verificados para la privacidad. Nunca contiene indicaciones, respuestas, rutas de origen, nombres de cuenta, sesiones de navegador ni secretos de dispositivos."],
  "Next verified upload": ["下一次已验证上传", "Próxima carga verificada"],
  "Inspect before sending": ["发送前检查", "Inspeccionar antes de enviar"],
  "Not inspected": ["未检查", "No inspeccionado"],
  "Covered period": ["覆盖期间", "Período cubierto"],
  "API-price estimate": ["API 价格估计", "Estimación de precio de API"],
  "Upload reservation": ["上传预留", "Reserva de carga"],
  "Inspect next": ["检查下一项", "Inspeccionar siguiente"],
  "Send reviewed upload": ["发送已审阅的上传", "Enviar carga revisada"],
  "Sending stays disabled until you open the exact local review for the current queued contribution.": ["在你打开当前排队贡献的精确本地审阅前，发送会保持禁用。", "El envío permanece desactivado hasta que abras la revisión local exacta de la contribución actual en cola."],
  "Review exact content-free metadata JSON": ["审阅确切的不含内容元数据 JSON", "Revisar el JSON exacto de metadatos sin contenido"],
  "This verified JSON is read from the owner-only prepared set over loopback. It has not been sent to the contribution service.": ["此已验证 JSON 通过回环从仅所有者可访问的准备集合中读取。它尚未发送到贡献服务。", "Este JSON verificado se lee mediante bucle local desde el conjunto preparado solo para el propietario. No se ha enviado al servicio de contribución."],
  "Inspection uses loopback only: it performs no service request, key fetch, authorization, or upload. The send action consumes a ten-minute, single-use local authorization and can claim only the exact reviewed queue job. The broader foreground CLI retains its independent bounded multi-job and upload-byte limits.": ["检查仅使用回环：不会执行服务请求、密钥获取、授权或上传。发送操作会使用一个十分钟、一次性的本地授权，并且只能提交确切审阅过的队列任务。更广泛的前台 CLI 保留其独立的有界多任务和上传字节限制。", "La inspección solo usa bucle local: no realiza solicitudes de servicio, obtención de claves, autorización ni carga. La acción de enviar consume una autorización local de un solo uso y diez minutos, y solo puede reclamar el trabajo de cola exacto revisado. La CLI de primer plano más amplia mantiene sus límites independientes para varios trabajos y bytes de carga."],
  "Automatic checks run at most every 6 hours while TiboTattle is open and only after explicit consent. No login item, LaunchAgent, daemon or silent background process is installed.": ["自动检查只会在 TiboTattle 打开期间最多每 6 小时运行一次，并且仅在明确同意后运行。不会安装登录项、LaunchAgent、守护进程或静默后台进程。", "Las comprobaciones automáticas se ejecutan como máximo cada 6 horas mientras TiboTattle está abierto y solo tras consentimiento explícito. No se instala ningún elemento de inicio de sesión, LaunchAgent, demonio ni proceso silencioso en segundo plano."],
  "Optional community service": ["可选的社区服务", "Servicio comunitario opcional"],
  "Community backend readiness and data lifecycle": ["社区后端就绪状态和数据生命周期", "Preparación del backend comunitario y ciclo de vida de datos"],
  "Checking backend": ["正在检查后端", "Comprobando el backend"],
  "This optional service is separate from the local collector above. Your local reporting works whether or not it is reachable, and nothing leaves this Mac unless you choose to contribute.": ["此可选服务与上方的本地收集器相互独立。无论它是否可访问，你的本地报告都能正常工作；除非你选择贡献，否则不会有任何内容离开这台 Mac。", "Este servicio opcional es independiente del recopilador local anterior. Tus informes locales funcionan tanto si es accesible como si no, y no sale nada de este Mac a menos que elijas contribuir."],
  "Service readiness and lifecycle detail": ["服务就绪状态和生命周期详情", "Detalles de preparación y ciclo de vida del servicio"],
  "Live readiness verifies database and encrypted-object access, fresh retention and restore replay, object reconciliation, and aggregate rebuild state. The repeatable backend suite covers the complete ingestion, isolation, export, and deletion lifecycle.": ["实时就绪状态会验证数据库和加密对象访问、最新的保留和恢复重放、对象对账及聚合重建状态。可重复的后端套件覆盖完整的摄取、隔离、导出和删除生命周期。", "La preparación en vivo verifica el acceso a la base de datos y a objetos cifrados, la retención reciente y la reproducción de restauración, la conciliación de objetos y el estado de reconstrucción de agregados. La suite repetible de backend cubre el ciclo de vida completo de ingesta, aislamiento, exportación y eliminación."],
  "Encrypted quarantine": ["加密隔离区", "Cuarentena cifrada"],
  "Retention & restore replay": ["保留和恢复重放", "Retención y reproducción de restauración"],
  "Object reconciliation": ["对象对账", "Conciliación de objetos"],
  "Aggregate rebuild": ["聚合重建", "Reconstrucción de agregados"],
  "Upload registration": ["上传注册", "Registro de carga"],
  "Ingestion processing": ["摄取处理", "Procesamiento de ingesta"],
  "Aggregate publication": ["聚合发布", "Publicación de agregados"],
  "Participant rights": ["参与者权利", "Derechos de participantes"],
  "Accepted upload contract": ["接受的上传契约", "Contrato de carga aceptado"],
  "Browser validation": ["浏览器验证", "Validación del navegador"],
  "Reject raw or oversized files before upload": ["上传前拒绝原始或超大文件", "Rechazar archivos sin procesar o demasiado grandes antes de la carga"],
  "Encrypted transport": ["加密传输", "Transporte cifrado"],
  "One-use upload authorization and envelope encryption": ["一次性上传授权和信封加密", "Autorización de carga de un solo uso y cifrado de envolvente"],
  "Server validation": ["服务器验证", "Validación del servidor"],
  "Closed schema, content-field rejection, and canonical repricing": ["封闭架构、内容字段拒绝和规范重新定价", "Esquema cerrado, rechazo de campos de contenido y nueva valoración canónica"],
  "Transactional ingest": ["事务性摄取", "Ingesta transaccional"],
  "Idempotent deduplication into participant-isolated records": ["幂等去重并写入参与者隔离记录", "Deduplicación idempotente en registros aislados por participante"],
  "Private analysis": ["私有分析", "Análisis privado"],
  "Personal cost, quota movement, and calibration results": ["个人成本、额度变化和校准结果", "Coste personal, movimiento de cuota y resultados de calibración"],
  "Delayed aggregate": ["延迟汇总", "Agregado diferido"],
  "Thresholded, clipped, rounded community snapshots": ["设有门槛、截断并取整的社区快照", "Resúmenes comunitarios con umbral, recorte y redondeo"],
  "Explicit hosted deletion remains available": ["明确的托管删除仍然可用", "La eliminación alojada explícita sigue disponible"],
  "Seven-day quarantine cleanup and deletion-safe restore replay": ["七天隔离区清理和删除安全的恢复重放", "Limpieza de cuarentena de siete días y reproducción de restauración segura ante eliminaciones"],
  "Account-scoped v0.2 ingest is disabled by default. A separately configured loopback-only preview can exercise the complete HTTP path; external participants remain unauthorized.": ["按帐户范围的 v0.2 摄取默认禁用。单独配置的仅回环预览可以执行完整 HTTP 路径；外部参与者仍未获授权。", "La ingesta v0.2 con ámbito de cuenta está desactivada de forma predeterminada. Una vista previa configurada por separado y solo de bucle local puede ejercer la ruta HTTP completa; los participantes externos siguen sin autorización."],
  "Your contributed evidence": ["你的已贡献证据", "Tu evidencia aportada"],
  "Your contribution receipt": ["你的贡献收据", "Tu recibo de contribución"],
  "Accepted intervals and private calculations appear here. Personal reporting remains in this local app; contribution helps improve the delayed community view.": ["已接受的区间和私有计算会显示在这里。个人报告保留在此本地应用中；贡献有助于改进延迟的社区视图。", "Los intervalos aceptados y los cálculos privados aparecen aquí. Los informes personales permanecen en esta app local; la contribución ayuda a mejorar la vista comunitaria diferida."],
  "No accepted contribution is associated with this browser yet.": ["尚无已接受的贡献与此浏览器关联。", "Todavía no hay ninguna contribución aceptada asociada a este navegador."],
  "Permanently remove the content-free pseudonymous metadata associated with this hosted contribution session.": ["永久移除此托管贡献会话关联的不含内容的假名化元数据。", "Elimina permanentemente los metadatos seudónimos sin contenido asociados con esta sesión de contribución alojada."],
  "Named with affection for the Codex community. Not affiliated with or endorsed by OpenAI or Thibault Sottiaux — and we will happily rename if asked. Your tokens tattle only to you.": ["这个名字是对 Codex 社区的亲切致意。它与 OpenAI 或 Thibault Sottiaux 没有隶属或认可关系；如被要求，我们会乐意更名。你的令牌只向你“告密”。", "Nombrado con afecto por la comunidad de Codex. No está afiliado a OpenAI ni a Thibault Sottiaux, ni cuenta con su respaldo; cambiaremos el nombre con gusto si nos lo piden. Tus tokens solo te cuentan a ti."],
  "Insufficient": ["不足", "Insuficiente"],
  "There is not yet a matched quota-and-cost window to compare.": ["尚无可比较的匹配额度与成本窗口。", "Aún no hay una ventana de cuota y coste coincidente para comparar."],
  "Not estimable": ["无法估算", "No estimable"],
  "No points fall inside this zoomed interval. Reset the view to return to the available evidence.": ["此缩放区间内没有数据点。请重置视图以返回可用证据。", "No hay puntos dentro de este intervalo ampliado. Restablece la vista para volver a la evidencia disponible."],
  "This historical calibration view has no per-window reset annotations. Treat it as diagnostic evidence, not a live allowance reading.": ["此历史校准视图没有逐窗口的重置注释。请将其视为诊断证据，而非实时额度读数。", "Esta vista histórica de calibración no tiene anotaciones de restablecimiento por ventana. Trátala como evidencia diagnóstica, no como una lectura de límite en vivo."],
  "No windows fall inside this date range.": ["此日期范围内没有窗口。", "No hay ventanas dentro de este intervalo de fechas."],
  "Price epoch was not verified": ["价格时期未验证", "La época de precios no se verificó"],
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
  "Connecting contribution…": ["正在连接贡献服务…", "Conectando la contribución…"],
  "Preparing locally…": ["正在本地准备…", "Preparando localmente…"],
  "Not validated": ["未验证", "No validado"],
  "Validated locally": ["已在本地验证", "Validado localmente"],
  "Rejected locally": ["已在本地拒绝", "Rechazado localmente"],
  "Not accepted": ["未接受", "No aceptado"],
  "Validating the privacy-safe export in this browser…": ["正在此浏览器中验证保护隐私的导出…", "Validando la exportación segura para la privacidad en este navegador…"],
  "Encrypting the validated export in this browser…": ["正在此浏览器中加密已验证的导出…", "Cifrando la exportación validada en este navegador…"],
  "Registering a one-use authorization for this exact encrypted envelope…": ["正在为此确切的加密信封注册一次性授权…", "Registrando una autorización de un solo uso para este sobre cifrado exacto…"],
  "Submitting encrypted telemetry for immediate server-side validation…": ["正在提交加密遥测数据以供立即进行服务器端验证…", "Enviando telemetría cifrada para validación inmediata en el servidor…"],
  "Local preparation available; community service not connected": ["本地准备可用；社区服务未连接", "Preparación local disponible; el servicio comunitario no está conectado"],
  "Community service unavailable": ["社区服务不可用", "El servicio comunitario no está disponible"],
  "Not connected": ["未连接", "Sin conexión"],
  "Turning off automatic contribution…": ["正在关闭自动贡献…", "Desactivando la contribución automática…"],
  "Turning off automatic contribution, then deleting hosted metadata…": ["正在关闭自动贡献，然后删除托管元数据…", "Desactivando la contribución automática y luego eliminando metadatos alojados…"],
  "Deleting this contribution and refreshing derived results…": ["正在删除此贡献并刷新派生结果…", "Eliminando esta contribución y actualizando los resultados derivados…"],
  "Contribution deleted. Private and community results have been refreshed.": ["贡献已删除。私有和社区结果已刷新。", "Contribución eliminada. Se actualizaron los resultados privados y comunitarios."],
  "Privacy-safe JSON export · 1.25 MB browser validation limit": ["保护隐私的 JSON 导出 · 浏览器验证上限为 1.25 MB", "Exportación JSON segura para la privacidad · límite de validación del navegador de 1,25 MB"],
  "Dashboard contract: waiting": ["仪表板契约：等待中", "Contrato del panel: en espera"],
  "Opening TiboTattle… If no app appears, install the signed Mac download above, then try again.": ["正在打开 TiboTattle…如果没有出现应用，请安装上方已签名的 Mac 下载，然后重试。", "Abriendo TiboTattle… Si no aparece la app, instala la descarga firmada para Mac de arriba y vuelve a intentarlo."],
  "Continue in the TiboTattle in-app window. If nothing opened, the app is not installed or macOS blocked the link.": ["请在 TiboTattle 应用内窗口继续。如果没有打开任何内容，说明应用未安装或 macOS 阻止了该链接。", "Continúa en la ventana integrada de TiboTattle. Si no se abrió nada, la app no está instalada o macOS bloqueó el enlace."],
  "Signed out on this page only. The in-memory sign-in was discarded and nothing was deleted: metadata you already contributed is unchanged, and Hosted privacy controls still export or delete it. Sign in again with any Google or Apple account.": ["仅在此页面退出登录。内存中的登录已被丢弃，未删除任何内容：你已贡献的元数据保持不变，托管隐私控制仍可导出或删除它。请使用任意 Google 或 Apple 帐户重新登录。", "Se cerró sesión solo en esta página. El inicio de sesión en memoria se descartó y no se eliminó nada: los metadatos que ya aportaste no cambian y los controles de privacidad alojados aún permiten exportarlos o eliminarlos. Vuelve a iniciar sesión con cualquier cuenta de Google o Apple."],
  "Clearing the unusable local device credential…": ["正在清除不可用的本地设备凭证…", "Borrando la credencial local de dispositivo inutilizable…"],
  "Automatic contribution is off. Already accepted metadata is unchanged; use Hosted privacy controls if you want it deleted.": ["自动贡献已关闭。已接受的元数据保持不变；如果要删除它，请使用托管隐私控制。", "La contribución automática está desactivada. Los metadatos ya aceptados no cambian; usa los controles de privacidad alojados si quieres eliminarlos."],
  "Sign in first: hosted participation requires Google or Apple sign-in above. Local-only use needs no account, and nothing was uploaded.": ["请先登录：托管参与需要使用上方的 Google 或 Apple 登录。本地使用不需要帐户，也没有上传任何内容。", "Inicia sesión primero: la participación alojada requiere iniciar sesión arriba con Google o Apple. El uso solo local no necesita cuenta y no se cargó nada."],
  "Creating pseudonymous contribution access and connecting this Mac…": ["正在创建假名化贡献访问权限并连接此 Mac…", "Creando acceso seudónimo de contribución y conectando este Mac…"],
  "Connected. Review the content-free result below before deciding whether to send it. Nothing will repeat automatically.": ["已连接。请在决定是否发送前审阅下方不含内容的结果。不会自动重复任何操作。", "Conectado. Revisa el resultado sin contenido de abajo antes de decidir si enviarlo. Nada se repetirá automáticamente."],
  "Analyze local usage to estimate privacy-safe records and upload batches before preparation.": ["在准备前分析本地使用情况，以估算保护隐私的记录和上传批次。", "Analiza el uso local para estimar registros seguros para la privacidad y lotes de carga antes de preparar."],
  "No privacy-safe records are visible in this indexed interval. Choose another window or update local usage first.": ["在这个已索引区间内没有可见的保护隐私记录。请选择另一个窗口或先更新本地使用情况。", "No hay registros seguros para la privacidad visibles en este intervalo indexado. Elige otra ventana o actualiza primero el uso local."],
  "The closed-schema browser preflight passed. Expand the review below before consenting.": ["闭合架构浏览器预检已通过。请在同意前展开下方审阅。", "La comprobación previa del navegador con esquema cerrado se aprobó. Expande la revisión de abajo antes de consentir."],
  "Your local usage, allowance estimates, and privacy review are working without a remote service. Community upload and aggregate comparisons appear only in a build with an explicit community-service origin.": ["你的本地使用情况、额度估算和隐私审阅无需远程服务即可运行。社区上传和聚合比较仅会出现在具有明确社区服务源的构建中。", "Tu uso local, las estimaciones de cuota y la revisión de privacidad funcionan sin un servicio remoto. La carga comunitaria y las comparaciones agregadas solo aparecen en una compilación con un origen explícito de servicio comunitario."],
  "This build has no community-service origin sealed into it, so there is no readiness to report.": ["此构建未封装社区服务源，因此没有可报告的就绪状态。", "Esta compilación no tiene un origen de servicio comunitario incorporado, por lo que no hay preparación que informar."],
  "No community origin is sealed into this app. Nothing is failing and no upload is attempted.": ["此应用未封装社区源。没有发生失败，也不会尝试上传。", "No hay ningún origen comunitario incorporado en esta app. Nada está fallando y no se intenta ninguna carga."],
  "Live readiness verifies database and encrypted-object access, fresh retention and restore replay, object reconciliation, and aggregate rebuild state.": ["实时就绪状态会验证数据库和加密对象访问、最新保留和恢复重放、对象对账以及聚合重建状态。", "La preparación en vivo verifica el acceso a la base de datos y a objetos cifrados, la retención reciente y la reproducción de restauración, la conciliación de objetos y el estado de reconstrucción de agregados."],
  "Your hosted content-free pseudonymous metadata was deleted.": ["你的托管不含内容的假名化元数据已被删除。", "Se eliminaron tus metadatos seudónimos alojados sin contenido."],
  "Nothing will be contributed. Your local reporting continues unchanged.": ["不会贡献任何内容。你的本地报告会继续保持不变。", "No se aportará nada. Tus informes locales continúan sin cambios."],
  "I consent to upload participant-scoped pseudonymous account tracks.": ["我同意上传按参与者范围划分的假名化帐户轨迹。", "Consiento cargar pistas de cuenta seudónimas con ámbito de participante."],
  "They link usage and quota rows only within this pseudonymous contribution session for private calibration; they are never published in community output and are deleted with the hosted session.": ["它们仅在此假名化贡献会话内关联使用和额度行以进行私有校准；绝不会在社区输出中发布，并会随托管会话一起删除。", "Vinculan filas de uso y cuota solo dentro de esta sesión seudónima de contribución para calibración privada; nunca se publican en la salida comunitaria y se eliminan con la sesión alojada."],
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
