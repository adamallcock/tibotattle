import { modelUsagePresentation, modelThemeIcon, compareModelPresentation } from "./model-visuals.js";
import { formatModelName } from "./ui-format.js";
import {
  REPORTING_PERIODS,
  REPORTING_DURATION_MS,
  normalizeReportingWindow,
  reportingRequestPeriod,
  reportingPeriodLabel,
} from "./dashboard-ui.js";
export { normalizeReportingWindow } from "./dashboard-ui.js";

// Presentation-only: the companion owns reconstruction, eligibility and bins.
const DAY = 86_400_000;
const PERIODS = ["1", "7", "30", "all"];
const STANDALONE_PERIODS = ["7", "30", "all"];
// The shared dashboard can request the 24-hour backend period (`1`), while
// the standalone controls intentionally expose only the standard periods.
const PRELOAD_PERIODS = STANDALONE_PERIODS;
const MAX_READY_PERIODS = 12;
// Keep the in-memory period cache useful across quick switches while ensuring
// each entry is eventually revalidated. The cache holds at most the four
// shared periods in three speed modes; it never persists measurements in browser storage.
const PERIOD_CACHE_TTL_MS = 60_000;
// A first history pass can take minutes. Continue bounded background retries
// while the document is visible instead of giving up after ten seconds.
const PRELOAD_MAX_ATTEMPTS = 24;
const preloadRetryDelay = attempt => Math.min(30_000, 5_000 * 2 ** attempt);
const SPEED_METHOD = "speed";
const SPEED_MODES = ["standard", "fast", "ultrafast"];
const MODEL_NAMES = Object.freeze({
  "gpt-6-astra": "Astra", "gpt-6-sol": "GPT-6 Sol", "gpt-6-luna": "GPT-6 Luna",
  "gpt-5.6-terra": "Terra", "gpt-5.6-sol": "Sol", "gpt-5.6-luna": "Luna",
  "gpt-5.5": "GPT-5.5", "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini", "gpt-5.3-codex-spark": "Spark",
  "gpt-5.3-codex": "GPT-5.3 Codex", "gpt-5.2-codex": "GPT-5.2 Codex", "gpt-5.2": "GPT-5.2",
});
const MODEL_ORDER = Object.freeze(Object.keys(MODEL_NAMES));
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export { reportingRequestPeriod } from "./dashboard-ui.js";

/** A closed, bounded display contract: never pass arbitrary source text to DOM. */
export function normalizeModelPerformance(value) {
  if (!exact(value, ["schemaVersion", "method", "status", "collecting", "stale", "updatedAt", "period", "interval", "start", "end", "historyProgress", "speedMode", "excludedUnknownTurns", "models"])
      || value.schemaVersion !== 5 || value.method !== 5
      || !SPEED_MODES.includes(value.speedMode) || !count(value.excludedUnknownTurns)
      || !["ready", "loading", "unavailable"].includes(value.status)
      || typeof value.collecting !== "boolean" || typeof value.stale !== "boolean" || !PERIODS.includes(value.period)
      || !["day", "week"].includes(value.interval) || !timestamp(value.end)
      || !(value.start === null || timestamp(value.start) && value.start <= value.end)
      || !(value.updatedAt === null || typeof value.updatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value.updatedAt) && Number.isFinite(Date.parse(value.updatedAt)))
      || !(value.historyProgress === null || exact(value.historyProgress, ["checked", "total"])
        && count(value.historyProgress.checked) && count(value.historyProgress.total)
        && value.historyProgress.checked <= value.historyProgress.total)
      || !Array.isArray(value.models) || value.models.length > 16) return null;
  const step = value.interval === "week" ? 7 * DAY : DAY;
  const seen = new Set();
  const validPoints = (points, maximum) => {
    if (!Array.isArray(points) || points.length > 2048) return false;
    let previous = -1, total = 0;
    for (const point of points) {
      if (!exact(point, ["at", "n", "p10", "p25", "median", "p75", "p90"]) || !timestamp(point.at)
          || point.at <= previous || point.at > value.end || (value.start !== null && point.at < value.start - step)
          || !count(point.n) || point.n < 1 || !Number.isFinite(point.median) || point.median < 0
          || point.median > 1e9) return false;
      if (point.n < 5 ? [point.p10, point.p25, point.p75, point.p90].some(value => value !== null)
        : ![point.p10, point.p25, point.p75, point.p90].every(Number.isFinite)
          || point.p10 < 0 || point.p10 > point.p25 || point.p25 > point.median
          || point.p75 < point.median || point.p90 < point.p75 || point.p90 > 1e9) return false;
      previous = point.at;
      total += point.n;
    }
    return total <= maximum;
  };
  for (const model of value.models) {
    if (!exact(model, ["id", "label", "turns", "speedTurns", "ttftTurns", "timedResponses", "speed", "ttft", "toolFreeTurns", "toolFree"])
        || !Object.hasOwn(MODEL_NAMES, model.id) || model.label !== MODEL_NAMES[model.id] || seen.has(model.id)
        || ![model.turns, model.speedTurns, model.ttftTurns, model.timedResponses].every(count)
        || model.speedTurns > model.turns || model.ttftTurns > model.turns
        || !Array.isArray(model.speed) || model.speed.length > 1 || !validPoints(model.ttft, model.ttftTurns)) return null;
    if (!count(model.toolFreeTurns) || model.toolFreeTurns > model.turns
        || !validPoints(model.toolFree, model.toolFreeTurns)) return null;
    seen.add(model.id);
    let speedCount = 0;
    for (const series of model.speed) {
      if (!exact(series, ["method", "points"]) || series.method !== SPEED_METHOD
          || !validPoints(series.points, model.speedTurns)) return null;
      speedCount += series.points.reduce((sum, point) => sum + point.n, 0);
    }
    if (speedCount > model.speedTurns) return null;
    if (model.toolFreeTurns > model.speedTurns) return null;
    const speedBins = new Map(model.speed.flatMap(series => series.points).map(point => [point.at, point.n]));
    if (model.toolFree.some(point => point.n > (speedBins.get(point.at) ?? 0))) return null;
  }
  return value;
}

/** Connect observed medians; missing bins use an honest dashed bridge. */
export function performanceSegments(points, interval) {
  const step = interval === "week" ? 7 * DAY : DAY;
  return points.slice(1).flatMap((point, index) => {
    const previous = points[index], gap = point.at - previous.at;
    return [{ from: previous, to: point, dashed: gap > step }];
  });
}

/** All-time focuses this model's measured era; all metrics retain one domain. */
export function performanceDomain(payload, model) {
  let start = payload.start;
  if (payload.period === "all") {
    let first = Infinity;
    for (const series of model.speed) if (series.points.length) first = Math.min(first, series.points[0].at);
    if (model.ttft.length) first = Math.min(first, model.ttft[0].at);
    if (Number.isFinite(first)) start = first;
  }
  return { start: start ?? payload.end, end: payload.end };
}

/** Zero-based 1/2/5 scales keep ticks legible without clipping the spread. */
export function performanceYScale(values) {
  const peak = Math.max(0, ...values.filter(value => Number.isFinite(value) && value >= 0));
  const rough = (peak || 1) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find(n => n * power >= rough) ?? 10) * power;
  const maximum = Math.ceil((peak || 1) / step) * step;
  const ticks = Array.from({ length: Math.round(maximum / step) + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { maximum, ticks, digits: Math.max(0, -Math.floor(Math.log10(step))) };
}

/** UTC calendar ticks, never fractional positions formatted as random dates. */
export function performanceDateTicks({ start, end }) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days = (end - start) / DAY, ticks = [];
  if (days <= 40) {
    const step = days <= 8 ? DAY : days <= 16 ? 2 * DAY : 7 * DAY;
    const anchor = step === 7 * DAY ? 4 * DAY : 0; // Mondays.
    for (let at = Math.ceil((start - anchor) / step) * step + anchor; at <= end; at += step) ticks.push(at);
  } else {
    const date = new Date(start);
    let year = date.getUTCFullYear(), month = date.getUTCMonth();
    const monthStep = days <= 100 ? 0 : days <= 240 ? 1 : days <= 730 ? 3 : 12 * Math.ceil(days / (365 * 6));
    if (monthStep >= 12) { year = Math.floor(year / (monthStep / 12)) * (monthStep / 12); month = 0; }
    else if (monthStep) month = Math.floor(month / monthStep) * monthStep;
    for (let i = 0; i < 32; i++) {
      const at = Date.UTC(year, month, 1);
      if (at > end) break;
      if (at >= start) ticks.push(at);
      if (!monthStep) {
        const mid = Date.UTC(year, month, 15);
        if (mid >= start && mid <= end) ticks.push(mid);
      }
      month += monthStep || 1;
    }
  }
  return ticks;
}

/** Snap to the calendar bin, including missing bins; never borrow a distant point. */
export function performanceHoverBin(fraction, { start, end }, interval) {
  const step = interval === 'week' ? 7 * DAY : DAY;
  const anchor = interval === 'week' ? 4 * DAY : 0;
  const at = start + Math.max(0, Math.min(1, fraction)) * (end - start);
  const first = Math.floor((start - anchor) / step), last = Math.floor((end - anchor) / step);
  return Math.max(first, Math.min(last, Math.round((at - anchor) / step))) * step + anchor;
}

export function mountModelPerformance(options = {}) {
  // The community variant is a separate, closed path. Local DTOs never pass
  // through it, and estimated community histograms never pass through here.
  if (options.source === "community") return mountCommunityModelPerformance(options);
  if (options.source !== undefined && options.source !== "local") throw new RangeError("Unsupported model performance source");
  const { root, client, t, locale = () => "en-US", windowRef = globalThis.window } = options;
  if (!root) return {
    render() {},
    refresh() {},
    preload: () => Promise.resolve(false),
    setReportingWindow() { return false; },
    cancel() {},
  };
  const documentRef = root.ownerDocument;
  let sharedReporting = options.sharedReporting === true || Object.hasOwn(options, "reportingWindow");
  const storageKey = "tibotattle.performance.v1";
  let saved = {};
  try { saved = JSON.parse(windowRef.localStorage.getItem(storageKey)) ?? {}; } catch { /* Storage can be disabled. */ }
  let period = STANDALONE_PERIODS.includes(saved.period) ? saved.period : "all";
  let reportingWindow = sharedReporting ? normalizeReportingWindow(options.reportingWindow) : null;
  let modelId = Object.hasOwn(MODEL_NAMES, saved.model) ? saved.model : null;
  let speedMode = "standard";
  let payload = null, loading = false, failed = false, cancelled = false, request = 0, timer = null;
  let retainedWindowKey = null;
  let retainedWindowUnavailable = false;
  let foregroundKey = null;
  // Retain only a bounded set of exact reporting windows for this mounted
  // local view. Shared end bounds can change as accounting snapshots advance.
  // No measurements or identity-bearing data enter browser storage.
  const readyPeriods = new Map();
  const rememberReady = (key, value) => {
    readyPeriods.delete(key);
    readyPeriods.set(key, { payload: value, cachedAt: Date.now() });
    while (readyPeriods.size > MAX_READY_PERIODS)
      readyPeriods.delete(readyPeriods.keys().next().value);
  };
  const pendingPeriods = new Map();
  let lifecycle = 0, scopeGeneration = 0, scopeUnavailable = false, destroyed = false;
  let preloadPromise = null, preloadComplete = false;
  const preloadWaiters = new Map();
  let aboutOpen = false, chartCursors = [];
  let selectedInterval = null;
  const showInterval = (at) => { if (at === selectedInterval) return; selectedInterval = at; for (const update of chartCursors) update(at); };
  const translate = (key, values) => t(`performance.${key}`, values);
  const reportTranslate = (key, values) => t(`reporting.${key}`, values);
  const reportingKey = () => sharedReporting
    ? `${reportingWindow?.period ?? "waiting"}:${reportingWindow?.startAt ?? ""}:${reportingWindow?.endAt ?? ""}`
    : period;
  const selectedRequestPeriod = () => sharedReporting
    ? reportingRequestPeriod(reportingWindow?.period)
    : period;
  const requestEndAt = () => sharedReporting ? reportingWindow?.endAt ?? null : null;
  let formatterLocale, numberFormat, integerFormat, dateFormat, fullDateFormat;
  function formatters() {
    const selectedLocale = locale();
    if (formatterLocale !== selectedLocale) {
      formatterLocale = selectedLocale;
      numberFormat = new Intl.NumberFormat(selectedLocale, { maximumFractionDigits: 1 });
      integerFormat = new Intl.NumberFormat(selectedLocale, { maximumFractionDigits: 0 });
      dateFormat = new Intl.DateTimeFormat(selectedLocale, { month: "short", day: "numeric", timeZone: "UTC" });
      fullDateFormat = new Intl.DateTimeFormat(selectedLocale, { dateStyle: "medium", timeZone: "UTC" });
    }
  }
  const number = (value) => { formatters(); return numberFormat.format(value); };
  const metricNumber = (value, metric) => { formatters(); return (metric === "latency" ? numberFormat : integerFormat).format(value); };
  const date = (value) => { formatters(); return dateFormat.format(value); };
  const visible = () => !root.classList.contains("dashboard-page-inactive") && !documentRef.hidden;
  const remember = () => {
    try {
      const preference = sharedReporting ? { model: modelId } : { period, model: modelId };
      windowRef.localStorage.setItem(storageKey, JSON.stringify(preference));
    } catch { /* Nonessential preference. */ }
  };
  const element = (name, className, text) => {
    const node = documentRef.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const evidenceRow = (kind, label, value, state = null) => {
    const row = element("div", "performance-evidence-row");
    row.dataset.evidence = kind;
    if (state) row.dataset.state = state;
    row.append(element("dt", "performance-evidence-label", label), element("dd", "performance-evidence-value", value));
    return row;
  };
  const derivedReportingStart = (window) => {
    if (!window?.endAt || window.period === "all") return null;
    const duration = window.period === "24h" ? DAY : window.period === "7d" ? 7 * DAY : 30 * DAY;
    return new Date(Date.parse(window.endAt) - duration).toISOString();
  };
  const reportingRange = (window, fallback = null) => {
    formatters();
    const selected = window ?? fallback;
    if (!selected) return null;
    const period = selected.period;
    const endAt = selected.endAt ?? (Number.isFinite(selected.end) ? new Date(selected.end).toISOString() : null);
    if (!endAt) return null;
    const end = fullDateFormat.format(new Date(endAt));
    if (period === "all") return reportTranslate("allThrough", { end });
    const startAt = selected.startAt ?? derivedReportingStart(selected)
      ?? (Number.isFinite(selected.start) ? new Date(selected.start).toISOString() : null);
    if (!startAt) return end;
    return reportTranslate("range", { start: fullDateFormat.format(new Date(startAt)), end });
  };
  const appendReportingEvidence = (container, selected = null) => {
    if ((!sharedReporting || retainedWindowKey !== null) && selected) {
      const fallback = { period: selected.period === "1" ? "24h" : selected.period === "7" ? "7d" : selected.period === "30" ? "30d" : "all", start: selected.start, end: selected.end };
      container.append(evidenceRow("period", reportTranslate("period"), `${reportingPeriodLabel(fallback.period, (key) => reportTranslate(key))} · ${reportingRange(null, fallback)}`));
    }
  };
  const appendPerformanceEvidence = (container, statusState) => {
    appendReportingEvidence(container, payload);
    if (payload?.updatedAt && statusState !== "ready") {
      formatters();
      const updated = fullDateFormat.format(new Date(payload.updatedAt));
      container.append(evidenceRow("freshness", translate("updated", { date: "" }).trim(), updated, payload.stale ? "stale" : "fresh"));
    }
  };
  const svgElement = (name, attributes = {}, text) => {
    const node = documentRef.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function plot(series, metric, color, domain) {
    const holder = element("div", "performance-plot");
    const points = series.flatMap((item) => item.points);
    if (!points.length) { holder.append(element("p", "performance-empty", translate(metric === "speed"
      ? "combinedSpeedEmpty" : "ttftEmpty"))); return holder; }
    const svg = svgElement("svg", { viewBox: "0 0 800 256", role: "group", "aria-label": translate(metric) });
    formatters();
    const { start, end } = domain;
    const scale = performanceYScale(points.map(point => point.p90 ?? point.median));
    const axisNumber = new Intl.NumberFormat(locale(), { maximumFractionDigits: metric === "latency" ? Math.min(20, scale.digits) : 0 });
    const plotLeft = 52, plotRight = 708, plotWidth = plotRight - plotLeft;
    const x = value => plotLeft + Math.max(0, Math.min(1, (value - start) / Math.max(1, end - start))) * plotWidth;
    const y = value => 214 - value / scale.maximum * 190;
    const curve = (a, b, key, reverse = false) => {
      const ax = x(a.at), ay = y(a[key]), bx = x(b.at), by = y(b[key]), control = (bx - ax) / 3;
      return reverse
        ? `M${bx},${by} C${bx - control},${by} ${ax + control},${ay} ${ax},${ay}`
        : `M${ax},${ay} C${ax + control},${ay} ${bx - control},${by} ${bx},${by}`;
    };
    const band = (a, b, low, high) => `${curve(a, b, low)} L${x(b.at)},${y(b[high])} ${curve(a, b, high, true).slice(1)} Z`;
    for (const value of scale.ticks) {
      svg.append(svgElement("line", { x1: plotLeft, x2: plotRight, y1: y(value), y2: y(value), class: "performance-grid" }),
        svgElement("text", { x: 42, y: y(value) + 4, "text-anchor": "end", class: "performance-axis" }, axisNumber.format(value)));
    }
    const dateTicks = performanceDateTicks(domain);
    const tickDate = new Intl.DateTimeFormat(locale(), { month: "short", ...(end - start > 730 * DAY ? { year: "numeric" } : { day: "numeric" }), timeZone: "UTC" });
    for (const at of dateTicks) {
      const px = x(at);
      svg.append(svgElement("line", { x1: px, x2: px, y1: 24, y2: 214, class: "performance-grid performance-date-grid" }),
        svgElement("text", { x: px, y: 244, "text-anchor": px < 80 ? "start" : px > plotRight - 30 ? "end" : "middle", class: "performance-axis" }, tickDate.format(at)));
    }
    svg.append(svgElement("path", { d: `M${plotLeft} 24V214H${plotRight}`, class: "performance-axis-line", fill: "none" }));
    const readout = element("p", "sr-only performance-readout", "");
    readout.setAttribute("aria-live", "polite");
    const tooltip = element("div", "performance-tooltip"); tooltip.hidden = true;
    tooltip.setAttribute("aria-hidden", "true");
    const percentileValues = point => point.p10 === null ? translate("percentilesUnavailable") : translate("percentileValues", {
      p10: metricNumber(point.p10, metric), p25: metricNumber(point.p25, metric), p75: metricNumber(point.p75, metric), p90: metricNumber(point.p90, metric),
    });
    const formatPoint = (point) => translate("point", { date: fullDateFormat.format(point.at), method: translate(metric), median: metricNumber(point.median, metric), percentiles: percentileValues(point), count: number(point.n) });
    const cursor = svgElement("line", { x1: 0, x2: 0, y1: 24, y2: 214, class: "performance-cursor", visibility: "hidden" });
    const markers = [];
    for (const item of series) {
      const gradientSuffix = `${metric}-${modelId}-${item.method}`;
      const defs = svgElement("defs");
      for (const [name, middleOpacity] of [["outer", .12], ["inner", .22]]) {
        const gradient = svgElement("linearGradient", { id: `performance-${name}-${gradientSuffix}`, x1: 0, y1: 0, x2: 0, y2: 1 });
        gradient.append(svgElement("stop", { offset: "0%", "stop-color": color, "stop-opacity": .035 }),
          svgElement("stop", { offset: "50%", "stop-color": color, "stop-opacity": middleOpacity }),
          svgElement("stop", { offset: "100%", "stop-color": color, "stop-opacity": .035 }));
        defs.append(gradient);
      }
      svg.append(defs);
      for (const segment of performanceSegments(item.points, payload.interval)) {
        const a = segment.from, b = segment.to;
        if (!segment.dashed && a.p10 !== null && b.p10 !== null) {
          svg.append(svgElement("path", { d: band(a, b, "p10", "p90"), fill: `url(#performance-outer-${gradientSuffix})`, class: "performance-percentile-band performance-percentile-band-outer" }),
            svgElement("path", { d: band(a, b, "p25", "p75"), fill: `url(#performance-inner-${gradientSuffix})`, class: "performance-percentile-band performance-percentile-band-inner" }));
          for (const key of ["p10", "p25", "p75", "p90"]) svg.append(svgElement("path", {
            d: curve(a, b, key), fill: "none", stroke: color,
            class: `performance-percentile-line performance-percentile-line-${key}`,
          }));
        }
        svg.append(svgElement("path", { d: curve(a, b, "median"), fill: "none", stroke: color,
          class: `performance-median-line${segment.dashed ? " performance-median-line-gap" : ""}` }));
      }
      for (const point of item.points) {
        const cx = x(point.at), cy = y(point.median);
        const marker = svgElement("g", { tabindex: -1, role: "img", "aria-label": formatPoint(point, item.method), class: "performance-point" });
        marker.dataset.performanceFocus = `point-${metric}-${item.method}-${point.at}`;
        // Pointer targets are independent of visible marker size; the whole plot
        // also accepts a horizontal sweep, including dates without evidence.
        marker.append(svgElement("circle", { cx, cy, r: 14, fill: "transparent", class: "performance-hit-target" }));
        marker.append(svgElement("circle", {
          cx, cy, r: 4,
          fill: point.n < 5 ? "var(--surface-raised)" : color, stroke: color, "stroke-width": 1.8,
        }));
        if (point.p10 !== null) svg.append(svgElement("line", { x1: cx, x2: cx, y1: y(point.p10), y2: y(point.p90), stroke: color, class: "performance-percentile-range" }),
          svgElement("line", { x1: cx, x2: cx, y1: y(point.p25), y2: y(point.p75), stroke: color, class: "performance-quartile-range" }));
        marker.addEventListener("focus", () => {
          for (const entry of markers) entry.node.setAttribute("tabindex", entry.node === marker ? "0" : "-1");
          showInterval(point.at);
        });
        marker.addEventListener("keydown", event => {
          if (event.key === "Escape") { showInterval(null); return; }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const index = markers.findIndex(entry => entry.node === marker);
          const next = event.key === "Home" ? 0 : event.key === "End" ? markers.length - 1 : Math.max(0, Math.min(markers.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
          event.preventDefault(); markers[next]?.node.focus();
        });
        markers.push({ node: marker, at: point.at }); svg.append(marker);
      }
    }
    markers.sort((a, b) => a.at - b.at);
    markers[0]?.node.setAttribute("tabindex", "0");
    const latest = [...(series[0]?.points ?? [])].reverse().find(point => point.p10 !== null);
    if (latest) {
      const unit = translate(metric === "latency" ? "latencyShortUnit" : "speedShortUnit");
      const labels = [["p90", "P90"], ["p75", "P75"], ["median", "P50"], ["p25", "P25"], ["p10", "P10"]]
        .map(([key, label]) => ({ key, label, actualY: y(latest[key]), labelY: y(latest[key]) }))
        .sort((a, b) => a.labelY - b.labelY);
      for (let i = 1; i < labels.length; i++) labels[i].labelY = Math.max(labels[i].labelY, labels[i - 1].labelY + 13);
      const overflow = Math.max(0, labels.at(-1).labelY - 210);
      if (overflow) for (const label of labels) label.labelY -= overflow;
      const underflow = Math.max(0, 28 - labels[0].labelY);
      if (underflow) for (const label of labels) label.labelY += underflow;
      for (const label of labels) {
        svg.append(svgElement("line", { x1: x(latest.at) + 3, y1: label.actualY, x2: 717, y2: label.labelY, stroke: color, class: "performance-endpoint-leader", "aria-hidden": "true" }),
          svgElement("circle", { cx: x(latest.at), cy: label.actualY, r: label.key === "median" ? 3.2 : 2.4, fill: color, class: "performance-endpoint-dot", "aria-hidden": "true" }),
          svgElement("text", { x: 721, y: label.labelY + 4, fill: color, class: `performance-endpoint-label${label.key === "median" ? " performance-endpoint-label-median" : ""}`, "aria-hidden": "true" }, `${label.label} ${metricNumber(latest[label.key], metric)} ${unit}`));
      }
    }
    const highlights = series.map(() => svgElement("circle", { r: 8, fill: "none", stroke: color, "stroke-width": 2.5, visibility: "hidden", class: "performance-highlight" }));
    svg.append(cursor, ...highlights);
    const byDate = series.map(item => new Map(item.points.map(point => [point.at, point])));
    chartCursors.push(at => {
      tooltip.hidden = at === null;
      cursor.setAttribute("visibility", at === null ? "hidden" : "visible");
      for (const highlight of highlights) highlight.setAttribute("visibility", "hidden");
      if (at === null) { readout.textContent = ""; return; }
      cursor.setAttribute("x1", x(at)); cursor.setAttribute("x2", x(at));
      const matches = series.flatMap((item, i) => {
        const point = byDate[i].get(at);
        if (!point) return [];
        highlights[i].setAttribute("cx", x(at)); highlights[i].setAttribute("cy", y(point.median)); highlights[i].setAttribute("visibility", "visible");
        return [{ point, method: item.method }];
      });
      tooltip.replaceChildren(element("strong", "performance-tooltip-date", fullDateFormat.format(at)));
      readout.textContent = matches.map(({ point, method }) => formatPoint(point, method)).join(" · ") || `${fullDateFormat.format(at)} · ${translate("noBin")}`;
      if (!matches.length) tooltip.append(element("p", "", translate("noBin")));
      for (const { point, method } of matches) {
        const row = element("div", "performance-tooltip-row");
        const unit = translate(metric === "latency" ? "latencyShortUnit" : "speedShortUnit");
        row.append(element("span", "performance-tooltip-method", method === "ttft" ? translate("latency") : translate("medianP50")),
          element("strong", "performance-tooltip-value", `${metricNumber(point.median, metric)} ${unit}`));
        const distribution = element("div", "performance-tooltip-percentiles");
        if (point.p10 === null) distribution.append(element("span", "performance-tooltip-detail", translate("percentilesUnavailable")));
        else for (const [label, value] of [["P90", point.p90], ["P75", point.p75], ["P25", point.p25], ["P10", point.p10]]) {
          distribution.append(element("span", "", label), element("strong", "", `${metricNumber(value, metric)} ${unit}`));
        }
        row.append(distribution, element("span", "performance-tooltip-detail", `${translate("turns")}: ${number(point.n)}`));
        tooltip.append(row);
      }
      const anchorY = matches.length ? y(matches[0].point.median) : 24;
      const bounds = svg.getBoundingClientRect();
      const anchorXCss = x(at) / 800 * bounds.width;
      const anchorYCss = anchorY / 256 * bounds.height;
      const tooltipHeight = tooltip.offsetHeight || 180;
      const vertical = bounds.top + anchorYCss >= tooltipHeight + 12 ? "above" : "below";
      const horizontal = anchorXCss >= bounds.width / 2 ? "before" : "after";
      tooltip.className = `performance-tooltip performance-tooltip-${horizontal} performance-tooltip-${vertical}`;
      tooltip.style.setProperty("--performance-tooltip-x", `${anchorXCss}px`);
      tooltip.style.setProperty("--performance-tooltip-y", `${anchorYCss}px`);
    });
    const sweep = event => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const px = (event.clientX - bounds.left) * 800 / bounds.width;
      const py = (event.clientY - bounds.top) * 256 / bounds.height;
      if (px < plotLeft || px > plotRight || py < 24 || py > 214) { showInterval(null); return; }
      showInterval(performanceHoverBin((px - plotLeft) / plotWidth, domain, payload.interval));
    };
    svg.addEventListener("pointermove", sweep);
    svg.addEventListener("pointerdown", sweep);
    svg.addEventListener("pointerleave", () => { showInterval(null); });
    svg.addEventListener("focusout", event => { if (!svg.contains(event.relatedTarget)) showInterval(null); });
    holder.append(svg, tooltip, readout);
    return holder;
  }
  function render() {
    const activeFocus = documentRef.activeElement?.dataset?.performanceFocus;
    const restoreFocus = () => {
      if (activeFocus) [...root.querySelectorAll("[data-performance-focus]")]
        .find((node) => node.dataset.performanceFocus === activeFocus)?.focus({ preventScroll: true });
    };
    chartCursors = []; selectedInterval = null;
    root.replaceChildren();
    const heading = element("div", "dashboard-page-header");
    const title = element("div");
    const h2 = element("h2", "", translate("title")); h2.id = "performance-title";
    h2.tabIndex = -1; h2.dataset.performanceFocus = "heading";
    title.append(h2, element("p", "page-description", translate("subtitle")));
    const periods = element("div", "segmented-control performance-periods"); periods.setAttribute("aria-label", translate("period")); periods.setAttribute("role", "group");
    for (const value of STANDALONE_PERIODS) {
      const button = element("button", value === period ? "active" : "", translate(value === "all" ? "all" : `days${value}`));
      button.type = "button"; button.setAttribute("aria-pressed", String(period === value)); button.dataset.performanceFocus = `period-${value}`;
      button.addEventListener("click", () => {
        if (period === value) return;
        period = value;
        payload = cachedPayload(value);
        remember(); render(); refresh();
      }); periods.append(button);
    }
    heading.append(title);
    if (!sharedReporting) heading.append(periods);
    root.append(heading, element("p", "performance-provider", translate("provider")));
    const modeControls = element("div", "performance-mode-controls");
    const modes = element("div", "segmented-control performance-modes");
    modes.setAttribute("role", "group"); modes.setAttribute("aria-label", translate("mode"));
    for (const value of SPEED_MODES) {
      const button = element("button", value === speedMode ? "active" : "", translate(value));
      button.type = "button"; button.setAttribute("aria-pressed", String(speedMode === value));
      button.dataset.performanceFocus = `mode-${value}`;
      button.addEventListener("click", () => {
        if (speedMode === value) return;
        speedMode = value;
        request++; scopeGeneration++;
        cancelPending(); cancelPreloadWaits();
        preloadPromise = null; preloadComplete = false; foregroundKey = null;
        windowRef.clearTimeout(timer); timer = null;
        retainedWindowKey = null; retainedWindowUnavailable = false;
        payload = cachedPayload(selectedRequestPeriod());
        loading = false; failed = false; cancelled = false; scopeUnavailable = false;
        render(); refresh();
      });
      modes.append(button);
    }
    modeControls.append(modes, element("p", "performance-mode-note", translate(`${speedMode}Note`)));
    root.append(modeControls);
    if (payload?.excludedUnknownTurns) root.append(element("p", "performance-mode-note", translate("unknownMode", { count: number(payload.excludedUnknownTurns) })));
    const status = element("p", "performance-status"); status.setAttribute("role", "status");
    const progress = payload?.historyProgress;
    const collectingLabel = progress?.total
      ? translate("buildingHistory", { checked: number(progress.checked), total: number(progress.total) })
      : translate("updating");
    const updatedLabel = payload?.updatedAt ? translate("updated", {
      date: new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(payload.updatedAt)),
    }) : "";
    const collectingStatus = payload?.status === "ready" && updatedLabel
      ? `${updatedLabel} · ${collectingLabel}` : collectingLabel;
    const statusState = cancelled ? "cancelled" : failed ? "error" : retainedWindowUnavailable ? "unavailable" : loading && !payload ? "loading" : payload?.collecting || payload?.status === "loading" ? "updating" : payload?.status === "unavailable" ? "unavailable" : payload?.updatedAt ? "ready" : sharedReporting && !reportingWindow ? "waiting" : "";
    status.dataset.state = statusState;
    status.textContent = cancelled ? translate("cancelled") : failed ? translate("failed") : retainedWindowUnavailable ? translate("unavailable") : loading && !payload ? translate("loading") : payload?.collecting || payload?.status === "loading" ? collectingStatus : payload?.status === "unavailable" ? translate("unavailable") : updatedLabel ? updatedLabel : sharedReporting && !reportingWindow ? reportTranslate("waiting") : "";
    const actions = element("div", "dashboard-actions performance-actions");
    actions.append(status);
    root.append(actions);
    if (payload?.stale) {
      const stale = element("p", "performance-status", translate("stale"));
      stale.dataset.state = "stale";
      actions.append(stale);
    }
    if (loading) {
      const cancel = element("button", "button button-secondary compact", translate("cancel")); cancel.type = "button"; cancel.dataset.performanceFocus = "cancel"; cancel.addEventListener("click", cancelRefresh); actions.append(cancel);
    } else if (failed || retainedWindowUnavailable || payload?.status === "unavailable") {
      const retry = element("button", "button button-secondary compact", translate("retry")); retry.type = "button"; retry.dataset.performanceFocus = "retry"; retry.addEventListener("click", refresh); actions.append(retry);
    }
    if (payload) {
      const evidence = element("dl", "performance-evidence");
      appendPerformanceEvidence(evidence, statusState);
      if (evidence.children.length) root.append(evidence);
    }
    const models = [...(payload?.models ?? [])].sort((a, b) => MODEL_ORDER.indexOf(a.id) - MODEL_ORDER.indexOf(b.id));
    if (!models.length) {
      if (payload?.status === "ready") {
        const empty = element("p", "performance-empty", translate("modeEmpty", { mode: translate(speedMode) }));
        empty.dataset.state = "empty";
        root.append(empty);
      }
      restoreFocus();
      return;
    }
    if (!models.some((model) => model.id === modelId)) modelId = models[0].id;
    const tabs = element("div", "performance-models"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", translate("models"));
    for (const model of models) {
      const presentation = modelUsagePresentation(model.id), displayName = formatModelName(model.id);
      const button = element("button", `performance-model ${presentation.className}`); button.type = "button";
      const icon = modelThemeIcon(documentRef, presentation.theme);
      if (icon) { icon.setAttribute("class", `allowance-model-icon performance-model-icon ${presentation.className}`); button.append(icon); }
      button.append(element("span", "", displayName));
      button.setAttribute("aria-label", displayName);
      button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(model.id === modelId)); button.setAttribute("aria-controls", "performance-model-panel"); button.tabIndex = model.id === modelId ? 0 : -1;
      button.id = `performance-tab-${model.id}`; button.dataset.performanceFocus = `model-${model.id}`;
      button.addEventListener("click", () => { modelId = model.id; remember(); render(); });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const index = models.indexOf(model);
        modelId = models[event.key === "Home" ? 0 : event.key === "End" ? models.length - 1 : (index + (event.key === "ArrowRight" ? 1 : models.length - 1)) % models.length].id;
        remember(); render(); documentRef.getElementById(`performance-tab-${modelId}`)?.focus();
      }); tabs.append(button);
    }
    root.append(tabs);
    const selected = models.find((model) => model.id === modelId);
    const selectedPresentation = modelUsagePresentation(selected.id), selectedName = formatModelName(selected.id);
    const domain = performanceDomain(payload, selected);
    const panel = element("div", `performance-model-panel ${selectedPresentation.className}`); panel.id = "performance-model-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `performance-tab-${modelId}`);
    const subheading = element("div", "performance-model-heading"), identity = element("h3", "performance-model-identity");
    const selectedIcon = modelThemeIcon(documentRef, selectedPresentation.theme);
    if (selectedIcon) { selectedIcon.setAttribute("class", `allowance-model-icon performance-model-icon ${selectedPresentation.className}`); identity.append(selectedIcon); }
    identity.append(element("span", "", selectedName));
    subheading.append(identity, element("span", "", translate(payload.interval))); panel.append(subheading);
    for (const metric of ["speed", "latency"]) {
      const card = element("article", "performance-card chart-card");
      const cardHeading = element("div", "performance-card-heading chart-card-header"), cardTitle = element("div");
      const summary = metric === "speed"
        ? translate("combinedSpeedSummary", { measured: number(selected.speedTurns), total: number(selected.turns),
            responses: number(selected.speedTurns - selected.toolFreeTurns), estimates: number(selected.toolFreeTurns) })
        : translate("latencySummary", { measured: number(selected.ttftTurns), total: number(selected.turns), responses: number(selected.timedResponses) });
      const coverage = element("p", "performance-unit", summary);
      const measured = metric === "speed" ? selected.speedTurns : selected.ttftTurns;
      coverage.dataset.state = measured < selected.turns ? "partial" : "complete";
      cardTitle.append(element("h4", "chart-card-title", translate(metric)), coverage);
      if (metric === "speed" && selected.toolFreeTurns > 0)
        cardTitle.append(element("p", "performance-method-note", translate("combinedSpeedMethodology")));
      const legend = element("div", "performance-legend chart-card-legend");
      for (const method of ["outerBand", "innerBand", "medianP50"]) {
        const entry = element("span", "performance-legend-item");
        const swatch = svgElement("svg", { width: method === "medianP50" ? 24 : 22, height: 16, viewBox: "0 0 24 16", "aria-hidden": "true" });
        const color = "var(--allowance-color)";
        swatch.append(svgElement(method === "medianP50" ? "line" : "rect", {
          ...(method === "medianP50" ? { x1: 1, y1: 8, x2: 23, y2: 8 } : { x: 1, y: method === "outerBand" ? 3 : 5, width: 22, height: method === "outerBand" ? 10 : 6, rx: 3 }),
          fill: color, stroke: color, opacity: method === "outerBand" ? .1 : method === "innerBand" ? .22 : 1,
          "stroke-width": method === "medianP50" ? 2.6 : 0,
        }));
        entry.append(swatch, element("span", "", translate(method))); legend.append(entry);
      }
      cardHeading.append(cardTitle); card.append(cardHeading, legend,
        // Each selected mode carries one combined, non-overlapping speed population.
        plot(metric === "speed" ? selected.speed : [{ method: "ttft", points: selected.ttft }], metric, "var(--allowance-color)", domain));
      panel.append(card);
    }
    const aboutSummary = element("summary", "", translate("about")); aboutSummary.dataset.performanceFocus = "about";
    const about = element("details", "performance-details"); about.open = aboutOpen; about.append(aboutSummary, element("p", "", translate("combinedMethodology")), element("p", "", translate("variance"))); about.addEventListener("toggle", () => { aboutOpen = about.open; }); panel.append(about);
    root.append(panel);
    restoreFocus();
  }
  const cacheKeyFor = (value, mode = speedMode, window = reportingWindow) => `${mode}::${sharedReporting
    ? `${window?.period ?? "waiting"}:${window?.startAt ?? ""}:${window?.endAt ?? ""}::${value}` : value}`;
  const cachedPayload = value => readyPeriods.get(cacheKeyFor(value))?.payload ?? null;
  const cacheFresh = entry => entry && Date.now() - entry.cachedAt < PERIOD_CACHE_TTL_MS;
  const preloadTargets = () => {
    if (!sharedReporting) return PRELOAD_PERIODS.map(value => ({ value, mode: speedMode, window: null }));
    if (!reportingWindow) return [];
    const endMs = Date.parse(reportingWindow.endAt);
    return REPORTING_PERIODS.flatMap(periodId => {
      const window = normalizeReportingWindow({
        period: periodId,
        startAt: periodId === "all" ? null
          : new Date(Math.max(0, endMs - REPORTING_DURATION_MS[periodId])).toISOString(),
        endAt: reportingWindow.endAt,
      });
      const value = reportingRequestPeriod(periodId);
      return SPEED_MODES.map(mode => ({ value, mode, window }));
    });
  };
  const allPeriodsFresh = () => {
    const targets = preloadTargets();
    return targets.length > 0
      && targets.every(({ value, mode, window }) => cacheFresh(readyPeriods.get(cacheKeyFor(value, mode, window))));
  };
  const documentVisible = () => !documentRef.hidden && !destroyed;
  const canPreload = (runLifecycle, runScope) => documentVisible()
    && lifecycle === runLifecycle && scopeGeneration === runScope;
  const cancelPending = ({ includeSpeculative = true } = {}) => {
    for (const [key, entry] of pendingPeriods) {
      if (!includeSpeculative && entry.speculative) continue;
      entry.controller.abort();
      if (pendingPeriods.get(key) === entry) pendingPeriods.delete(key);
    }
  };
  const cancelPreloadWaits = () => {
    for (const finish of preloadWaiters.values()) finish(false);
  };
  const invalidateScope = (sourcePeriod, unavailable, sourceKey) => {
    if (retainedWindowKey !== reportingKey() || payload?.status !== "ready") retainedWindowKey = null;
    scopeGeneration++;
    scopeUnavailable = true;
    preloadComplete = false;
    cancelPreloadWaits();
    readyPeriods.clear();
    // An unavailable response describes the complete local scope. Abort
    // requests from the prior scope so they cannot spend work or repopulate
    // the cache after invalidation. Keep the response that established the
    // invalidation alive for its caller.
    for (const [key, entry] of pendingPeriods) if (key !== sourceKey) {
      entry.controller.abort();
      if (pendingPeriods.get(key) === entry) pendingPeriods.delete(key);
    }
    // A sibling period can discover that the whole scope is unavailable while
    // the selected period is still displaying a previous ready value. Remove
    // that value immediately, including on an inactive page, so first visit
    // cannot resurrect stale evidence.
    const selected = selectedRequestPeriod();
    if (!destroyed && selected !== sourcePeriod) {
      payload = { ...unavailable, period: selected ?? unavailable.period };
      failed = false;
      render();
    }
  };
  const presentResult = (value, result) => {
    if (!result || value !== selectedRequestPeriod() || result.speedMode !== speedMode) return false;
    if (result.status === "unavailable") readyPeriods.clear();
    if (result.status === "unavailable" && retainedWindowKey === reportingKey() && payload?.status === "ready") {
      // An unavailable new window withdraws live caches, but the previous
      // window remains readable as dated historical evidence until retry.
      payload = { ...payload, collecting: false, stale: true };
      retainedWindowUnavailable = true;
      return true;
    }
    retainedWindowUnavailable = false;
    const retained = result.status === "loading" ? cachedPayload(value)
      ?? (retainedWindowKey === reportingKey() && payload?.status === "ready" ? payload : null) : null;
    if (result.status !== "loading") retainedWindowKey = null;
    const next = retained ? { ...retained, collecting: true, stale: true } : result;
    const changed = JSON.stringify({ ...next, updatedAt: null }) !== JSON.stringify(payload ? { ...payload, updatedAt: null } : null);
    payload = next;
    return changed;
  };
  function requestPeriod(value, { force = false, speculative = false,
    mode = speedMode, window = reportingWindow } = {}) {
    if (!PERIODS.includes(value) || !SPEED_MODES.includes(mode)
        || sharedReporting && (!window || value !== reportingRequestPeriod(window.period))) {
      return Promise.reject(new RangeError("Unsupported performance period"));
    }
    const cacheKey = cacheKeyFor(value, mode, window);
    const existing = pendingPeriods.get(cacheKey);
    if (existing) return existing.promise;
    const entry = readyPeriods.get(cacheKey);
    if (!force && cacheFresh(entry)) return Promise.resolve(entry.payload);
    const expectedMode = mode;
    const expectedWindow = sharedReporting ? window : null;
    const expectedEndAt = expectedWindow?.endAt ?? null;
    const expectedStartAt = expectedWindow?.startAt ?? null;
    const controller = new AbortController();
    const startedLifecycle = lifecycle;
    const startedScope = scopeGeneration;
    let timedOut = false;
    const deadline = windowRef.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    const record = { controller, promise: null, speculative };
    const promise = (async () => {
      try {
        const result = normalizeModelPerformance(await client.modelPerformance(value, {
          signal: controller.signal, speedMode: expectedMode,
          ...(expectedEndAt ? { endAt: expectedEndAt } : {}),
        }));
        if (!result || result.period !== value || result.speedMode !== expectedMode
            || (expectedEndAt && result.end !== Date.parse(expectedEndAt))
            || (expectedStartAt !== null && result.start !== Date.parse(expectedStartAt))) {
          throw new Error("Invalid timing contract");
        }
        // Hidden/destroyed views and responses from an invalidated scope may
        // finish, but they must not affect the visible state or cache.
        if (destroyed || lifecycle !== startedLifecycle || scopeGeneration !== startedScope) return null;
        // Some clients may ignore AbortSignal and resolve after the deadline.
        // Treat that response as timed out so a late result cannot become a
        // fresh cache entry or replace the current period.
        if (controller.signal.aborted) {
          if (timedOut) throw new Error("Performance request timed out");
          return null;
        }
        if (result.status === "unavailable") invalidateScope(value, result, cacheKey);
        else {
          scopeUnavailable = false;
          if (result.status === "ready") rememberReady(cacheKey, result);
        }
        return result;
      } finally {
        windowRef.clearTimeout(deadline);
        if (pendingPeriods.get(cacheKey) === record) pendingPeriods.delete(cacheKey);
      }
    })();
    record.promise = promise;
    pendingPeriods.set(cacheKey, record);
    return promise;
  }
  function waitForPreload(delay, runLifecycle, runScope) {
    return new Promise(resolve => {
      let timeout;
      const finish = value => {
        if (!preloadWaiters.delete(timeout)) return;
        windowRef.clearTimeout(timeout);
        resolve(value && canPreload(runLifecycle, runScope));
      };
      timeout = windowRef.setTimeout(() => finish(true), delay);
      preloadWaiters.set(timeout, finish);
    });
  }
  async function preloadPeriod({ value, mode, window }, runLifecycle, runScope) {
    for (let attempt = 0; attempt < PRELOAD_MAX_ATTEMPTS; attempt++) {
      if (!canPreload(runLifecycle, runScope)) return null;
      let result = null;
      try { result = await requestPeriod(value, { speculative: true, mode, window }); }
      catch { if (!canPreload(runLifecycle, runScope)) return null; }
      if (result?.status === "unavailable") {
        if (mode === speedMode && value === selectedRequestPeriod() && presentResult(value, result)) render();
        return result;
      }
      if (!canPreload(runLifecycle, runScope)) return null;
      if (result) {
        if (mode === speedMode && presentResult(value, result)) render();
        if (result.status === "ready") return result;
      }
      if (attempt + 1 < PRELOAD_MAX_ATTEMPTS
          && !await waitForPreload(preloadRetryDelay(attempt), runLifecycle, runScope)) return null;
    }
    return null;
  }
  async function runPreload(runLifecycle, runScope) {
    if (!sharedReporting) {
      const targets = preloadTargets().sort((left, right) =>
        Number(right.value === selectedRequestPeriod()) - Number(left.value === selectedRequestPeriod()));
      for (const target of targets) {
        const result = await preloadPeriod(target, runLifecycle, runScope);
        if (result?.status === "unavailable" || !canPreload(runLifecycle, runScope)) return;
      }
      return;
    }
    // Every exact period/mode window shares the same timing worker. Register
    // them together so one background history pass can fill every period/mode view.
    await Promise.all(preloadTargets().map(target => preloadPeriod(target, runLifecycle, runScope)));
  }
  function preload() {
    if (destroyed || documentRef.hidden) return Promise.resolve();
    if (preloadPromise) return preloadPromise;
    if (!preloadTargets().length) return Promise.resolve(false);
    if (preloadComplete && allPeriodsFresh()) return Promise.resolve();
    preloadComplete = false;
    const runLifecycle = lifecycle, runScope = scopeGeneration;
    const operation = (async () => {
      try { await runPreload(runLifecycle, runScope); }
      catch { /* Speculative warming is best effort; foreground refresh remains authoritative. */ }
    })();
    preloadPromise = operation;
    void operation.finally(() => {
      if (preloadPromise !== operation) return;
      preloadPromise = null;
      preloadComplete = allPeriodsFresh();
    });
    return operation;
  }
  async function warmOtherPeriods() {
    if (sharedReporting || !visible() || destroyed || scopeUnavailable || payload?.status === "unavailable") return;
    const selectedPeriod = period;
    await Promise.all(PRELOAD_PERIODS.filter(value => value !== selectedPeriod).map(async value => {
      if (!visible() || destroyed) return;
      const entry = readyPeriods.get(cacheKeyFor(value));
      if (cacheFresh(entry)) return;
      try { await requestPeriod(value); } catch { /* Background warming is best effort. */ }
    }));
  }
  async function refresh() {
    if (!visible() || destroyed) return;
    if (sharedReporting && !reportingWindow) {
      cancelPending();
      foregroundKey = null;
      loading = false;
      failed = false;
      cancelled = false;
      payload = null;
      render();
      return;
    }
    const current = ++request;
    const startedLifecycle = lifecycle;
    const startedScope = scopeGeneration;
    const targetPeriod = selectedRequestPeriod();
    if (!targetPeriod) return;
    const targetKey = cacheKeyFor(targetPeriod);
    foregroundKey = targetKey;
    const hadFailure = failed || retainedWindowUnavailable;
    retainedWindowUnavailable = false;
    if (retainedWindowKey === reportingKey() && payload?.status === "ready")
      payload = { ...payload, collecting: true, stale: true };
    scopeUnavailable = false;
    loading = true; failed = false; cancelled = false; windowRef.clearTimeout(timer);
    // A cached period remains visible while its replacement is fetched.
    if (!payload || hadFailure) render();
    let changed = false, shouldWarm = false;
    try {
      const result = await requestPeriod(targetPeriod, { force: true });
      if (request !== current || lifecycle !== startedLifecycle || destroyed || !result) return;
      shouldWarm = !sharedReporting && result.status !== "unavailable";
      changed = presentResult(targetPeriod, result);
    } catch {
      if (request !== current || lifecycle !== startedLifecycle || destroyed) return;
      // Keep a good period visible through transient foreground failures. A
      // scope invalidation that aborted this request already rendered its
      // unavailable state, so do not replace it with a generic failure.
      failed = scopeGeneration === startedScope;
    } finally {
      if (foregroundKey === targetKey && request === current) foregroundKey = null;
      if (request === current && lifecycle === startedLifecycle && !destroyed) {
        loading = false; if (changed || failed || !payload) render();
        if (visible()) {
          timer = windowRef.setTimeout(refresh, failed ? 30_000 : 10_000);
          if (shouldWarm && !scopeUnavailable) void warmOtherPeriods();
        }
      }
    }
  }
  function cancelRefresh() {
    if (!loading) return;
    request++;
    const key = foregroundKey;
    const entry = key ? pendingPeriods.get(key) : null;
    if (entry) {
      entry.controller.abort();
      if (pendingPeriods.get(key) === entry) pendingPeriods.delete(key);
    }
    foregroundKey = null;
    windowRef.clearTimeout(timer);
    timer = null;
    loading = false;
    failed = false;
    cancelled = true;
    render();
  }
  const rootVisibilityChanged = () => {
    if (visible()) { if (!loading) refresh(); }
    else {
      windowRef.clearTimeout(timer);
      request++;
      loading = false;
      foregroundKey = null;
      // A page transition should stop its foreground poll, while a
      // document-visible speculative preload is allowed to finish for the
      // first visit. Document hiding below cancels both kinds of work.
      cancelPending({ includeSpeculative: false });
    }
  };
  const documentVisibilityChanged = () => {
    if (documentRef.hidden) {
      windowRef.clearTimeout(timer);
      lifecycle++;
      cancelPending();
      cancelPreloadWaits();
      if (preloadPromise && !preloadComplete) preloadPromise = null;
      request++;
      loading = false;
      foregroundKey = null;
    } else if (visible() && !loading) refresh();
  };
  function setReportingWindow(value) {
    const next = normalizeReportingWindow(value);
    const retainPrevious = next && reportingWindow && next.period === reportingWindow.period
      && Date.parse(next.endAt) > Date.parse(reportingWindow.endAt) && payload?.status === "ready";
    const previousPayload = retainPrevious ? payload : null;
    const previousKey = reportingKey();
    sharedReporting = true;
    reportingWindow = next;
    const nextKey = reportingKey();
    if (previousKey === nextKey) {
      if (next === null) {
        loading = false;
        failed = false;
        cancelled = false;
        payload = null;
        render();
      }
      return next !== null;
    }
    request++;
    scopeGeneration++;
    cancelPending();
    cancelPreloadWaits();
    preloadPromise = null;
    preloadComplete = false;
    foregroundKey = null;
    windowRef.clearTimeout(timer);
    timer = null;
    loading = false;
    failed = false;
    cancelled = false;
    scopeUnavailable = false;
    payload = next === null
      ? null
      : readyPeriods.get(cacheKeyFor(selectedRequestPeriod()))?.payload ?? null;
    retainedWindowKey = null;
    retainedWindowUnavailable = false;
    if (!payload && previousPayload) {
      // Show the prior report under its own bounds while the new exact
      // window loads. It must never become a cache entry for the new window.
      payload = { ...previousPayload, collecting: true, stale: true };
      retainedWindowKey = nextKey;
    }
    render();
    if (next !== null && visible()) refresh();
    return next !== null;
  }
  const observer = new windowRef.MutationObserver(rootVisibilityChanged);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  documentRef.addEventListener("visibilitychange", documentVisibilityChanged);
  render();
  if (visible()) refresh();
  return {
    render,
    refresh,
    preload,
    setReportingWindow,
    cancel: cancelRefresh,
    destroy() {
      destroyed = true;
      lifecycle++;
      readyPeriods.clear();
      payload = null;
      observer.disconnect();
      cancelPending();
      cancelPreloadWaits();
      preloadPromise = null;
      preloadComplete = false;
      foregroundKey = null;
      request++;
      windowRef.clearTimeout(timer);
      documentRef.removeEventListener("visibilitychange", documentVisibilityChanged);
    },
  };
}

// ---------------------------------------------------------------------------
// Community display variant.
//
// Input is the closed output of community-data.js's
// normalizeCommunityModelPerformance (SPD-W1a). The adapter below re-checks
// that shape and produces a separate display contract: estimates keep their
// conservative bounds, latency is converted from milliseconds to seconds,
// and day strings become UTC epochs. It never produces, or flows through, the
// exact local DTO above.
const COMMUNITY_SCHEMA_VERSION = "community-model-performance-v1";
const COMMUNITY_METHOD_VERSION = "performance-histogram-pool-type7-bounds-v1";
const COMMUNITY_POPULATION = "reported_samples";
const COMMUNITY_PERIODS = Object.freeze(["1", "7", "30", "all"]);
// One closed publication per slot is refreshed at most every five minutes,
// sharing the public per-client budget. Other periods are never warmed.
const COMMUNITY_REFRESH_INTERVAL_MS = 300_000;
const COMMUNITY_REQUEST_TIMEOUT_MS = 15_000;
const COMMUNITY_MAX_MODELS = 64;
const COMMUNITY_MAX_POINTS = 600;
const COMMUNITY_MAX_SLOTS = COMMUNITY_PERIODS.length * SPEED_MODES.length;
const COMMUNITY_PERCENTILES = Object.freeze(["p10", "p25", "median", "p75", "p90"]);
const COMMUNITY_PUBLISHED_KEYS = Object.freeze([
  "state", "schemaVersion", "methodVersion", "population", "approximate", "revision",
  "generatedAt", "period", "interval", "start", "end", "speedMode",
  "excludedUnknownTurns", "contributors", "devices", "reports", "models", "omittedModels",
]);
const COMMUNITY_MODEL_KEYS = Object.freeze([
  "provider", "modelId", "turns", "speedTurns", "ttftTurns", "timedResponses",
  "toolFreeTurns", "contributors", "devices", "speed", "ttft", "label",
]);
const COMMUNITY_SERIES = Object.freeze([
  Object.freeze({ metric: "speed", unit: "tokens_per_second", divisor: 1 }),
  Object.freeze({ metric: "ttft", unit: "milliseconds", divisor: 1000 }),
]);
const COMMUNITY_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const COMMUNITY_DAY = /^\d{4}-\d\d-\d\d$/u;
// Copy that differs in community mode; every other key keeps its shared text.
// Shared keys that describe this device's measured turns or saved results are
// scoped too, so pooled reported samples never borrow local wording.
const COMMUNITY_COPY_SCOPE = Object.freeze({
  provider: "community.provider", subtitle: "community.subtitle", turns: "community.turns",
  point: "community.point", methodology: "community.methodology", variance: "community.variance",
  standardNote: "community.standardNote", fastNote: "community.fastNote", ultrafastNote: "community.ultrafastNote",
  unknownMode: "community.unknownMode", modeEmpty: "community.modeEmpty",
  combinedSpeedEmpty: "community.combinedSpeedEmpty", cancelled: "community.cancelled",
});
const communityDayEpoch = (value) => {
  if (typeof value !== "string" || !COMMUNITY_DAY.test(value)) return null;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
};
const communityInstant = (value) => typeof value === "string" && value.length <= 32
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const communityValue = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12;

function communityQuantile(value, divisor) {
  if (!exact(value, ["estimate", "lower", "upper"])
      || ![value.estimate, value.lower, value.upper].every(communityValue)
      || value.lower > value.estimate || value.estimate > value.upper) return null;
  return { estimate: value.estimate / divisor, lower: value.lower / divisor, upper: value.upper / divisor };
}

function communityPoint(value, metric, divisor) {
  if (!exact(value, ["day", "n", "unresolved", ...COMMUNITY_PERCENTILES])) return null;
  const at = communityDayEpoch(value.day);
  if (at === null || !count(value.n) || value.n < 1 || !count(value.unresolved)
      || value.unresolved > value.n || (metric !== "speed" && value.unresolved !== 0)) return null;
  // The under-five rule: a sparse point keeps only its median, with bounds.
  const banded = value.n >= 5;
  const point = { at, n: value.n, unresolved: value.unresolved };
  for (const key of COMMUNITY_PERCENTILES) {
    if (value[key] === null) {
      if (banded || key === "median") return null;
      point[key] = null;
      continue;
    }
    if (!banded && key !== "median") return null;
    const quantile = communityQuantile(value[key], divisor);
    if (!quantile) return null;
    point[key] = quantile;
  }
  return point;
}

function communitySeries(value, { metric, unit, divisor }, interval, start, endDay) {
  if (!exact(value, ["unit", "points"]) || value.unit !== unit
      || !Array.isArray(value.points) || value.points.length > COMMUNITY_MAX_POINTS) return null;
  const points = [];
  let previous = -Infinity, samples = 0;
  for (const candidate of value.points) {
    const point = communityPoint(candidate, metric, divisor);
    // Week bins are named by their Monday and may begin before the window.
    if (!point || point.at <= previous || point.at > endDay
        || (interval === "day" && point.at < start)
        || (interval === "week" && (new Date(point.at).getUTCDay() !== 1 || point.at + 6 * DAY < start))) return null;
    previous = point.at;
    samples += point.n;
    points.push(point);
  }
  return Number.isSafeInteger(samples) ? { points, samples } : null;
}

/**
 * Display adapter for one published community slot. Returns null for any
 * other state or for a value that is not the closed normalized shape, so a
 * raw or partially trusted body can never render.
 */
export function normalizeCommunityPerformanceDisplay(value) {
  if (!exact(value, COMMUNITY_PUBLISHED_KEYS) || value.state !== "published"
      || value.schemaVersion !== COMMUNITY_SCHEMA_VERSION || value.methodVersion !== COMMUNITY_METHOD_VERSION
      || value.population !== COMMUNITY_POPULATION || value.approximate !== true
      || !count(value.revision) || value.revision < 1 || !communityInstant(value.generatedAt)
      || !COMMUNITY_PERIODS.includes(value.period) || !["day", "week"].includes(value.interval)
      || (value.period !== "all" && value.interval !== "day")
      || !SPEED_MODES.includes(value.speedMode)
      || ![value.excludedUnknownTurns, value.contributors, value.devices, value.reports].every(count)
      || value.devices < value.contributors || value.reports < value.devices
      || !exact(value.omittedModels, ["models", "turns"])
      || !count(value.omittedModels.models) || !count(value.omittedModels.turns)
      || !Array.isArray(value.models) || value.models.length > COMMUNITY_MAX_MODELS) return null;
  const start = communityDayEpoch(value.start), endDay = communityDayEpoch(value.end);
  if (start === null || endDay === null || start > endDay
      || (value.period !== "all" && endDay - start !== (Number(value.period) - 1) * DAY)) return null;
  const seen = new Set(), models = [];
  let samples = value.omittedModels.turns;
  for (const model of value.models) {
    if (!exact(model, COMMUNITY_MODEL_KEYS) || typeof model.provider !== "string" || !COMMUNITY_TOKEN.test(model.provider)
        || typeof model.modelId !== "string" || !COMMUNITY_TOKEN.test(model.modelId) || seen.has(model.modelId)
        || typeof model.label !== "string" || model.label.length < 1 || model.label.length > 64
        || ![model.turns, model.speedTurns, model.ttftTurns, model.timedResponses, model.toolFreeTurns,
          model.contributors, model.devices].every(count)
        || model.turns < 1 || model.contributors < 1 || model.devices < model.contributors
        || model.contributors > value.contributors || model.devices > value.devices
        || model.speedTurns > model.turns || model.ttftTurns > model.turns
        || model.toolFreeTurns > model.speedTurns) return null;
    const [speed, ttft] = COMMUNITY_SERIES.map(shape => communitySeries(model[shape.metric], shape, value.interval, start, endDay));
    if (!speed || !ttft || speed.samples !== model.speedTurns || ttft.samples !== model.ttftTurns) return null;
    seen.add(model.modelId);
    samples += model.turns;
    models.push({
      id: model.modelId, label: model.label,
      turns: model.turns, speedTurns: model.speedTurns, ttftTurns: model.ttftTurns,
      timedResponses: model.timedResponses, toolFreeTurns: model.toolFreeTurns,
      contributors: model.contributors, devices: model.devices,
      unresolved: speed.points.reduce((sum, point) => sum + point.unresolved, 0),
      speed: speed.points, ttft: ttft.points,
    });
  }
  if (!Number.isSafeInteger(samples)) return null;
  const omittedModels = { models: value.omittedModels.models, turns: value.omittedModels.turns };
  return {
    period: value.period, interval: value.interval, speedMode: value.speedMode,
    // Day epochs for the window; the end is the last millisecond of its UTC day.
    start, end: endDay + DAY - 1,
    excludedUnknownTurns: value.excludedUnknownTurns,
    evidence: {
      contributors: value.contributors, devices: value.devices, reports: value.reports,
      samples, revision: value.revision, generatedAt: value.generatedAt, omittedModels,
    },
    omittedModels,
    models: models.sort((a, b) => compareModelPresentation(a.id, b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** All-time focuses the measured era; one closed UTC day is centred on its bin. */
function communityDomain(display, model) {
  if (display.period === "1") return { start: display.start - DAY / 2, end: display.start + DAY / 2 };
  let start = display.start;
  const first = Math.min(model.speed[0]?.at ?? Infinity, model.ttft[0]?.at ?? Infinity);
  if (display.period === "all" && Number.isFinite(first)) start = first;
  else if (Number.isFinite(first)) start = Math.min(start, first);
  return { start, end: display.end };
}

function mountCommunityModelPerformance(options) {
  const { root, client, t, locale = () => "en-US", windowRef = globalThis.window } = options;
  const inert = {
    render() {}, refresh() {}, preload: () => Promise.resolve(false),
    setReportingWindow() { return false; }, cancel() {}, destroy() {},
  };
  if (!root) return inert;
  if (options.sharedReporting === true || Object.hasOwn(options, "reportingWindow"))
    throw new TypeError("Community model performance has no shared reporting window");
  const refreshIntervalMs = options.refreshIntervalMs ?? COMMUNITY_REFRESH_INTERVAL_MS;
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 1_000)
    throw new RangeError("Unsupported community refresh interval");
  const documentRef = root.ownerDocument;
  let period = COMMUNITY_PERIODS.includes(options.period) ? options.period : "all";
  let speedMode = SPEED_MODES.includes(options.speedMode) ? options.speedMode : "standard";
  let modelId = null, display = null, slotState = null;
  let loading = false, failed = false, cancelled = false, destroyed = false;
  let request = 0, lifecycle = 0, timer = null, pending = null;
  let aboutOpen = false, chartCursors = [], selectedInterval = null;
  // In-memory only, bounded to the twelve slots; nothing enters browser storage.
  const slots = new Map();
  const slotKey = () => `${speedMode}::${period}`;
  const showInterval = (at) => { if (at === selectedInterval) return; selectedInterval = at; for (const update of chartCursors) update(at); };
  const translate = (key, values) => t(`performance.${COMMUNITY_COPY_SCOPE[key] ?? key}`, values);
  const reportTranslate = (key, values) => t(`reporting.${key}`, values);
  let formatterLocale, numberFormat, integerFormat, fullDateFormat, dateTimeFormat;
  function formatters() {
    const selectedLocale = locale();
    if (formatterLocale !== selectedLocale) {
      formatterLocale = selectedLocale;
      numberFormat = new Intl.NumberFormat(selectedLocale, { maximumFractionDigits: 1 });
      integerFormat = new Intl.NumberFormat(selectedLocale, { maximumFractionDigits: 0 });
      fullDateFormat = new Intl.DateTimeFormat(selectedLocale, { dateStyle: "medium", timeZone: "UTC" });
      dateTimeFormat = new Intl.DateTimeFormat(selectedLocale, { dateStyle: "medium", timeStyle: "short" });
    }
  }
  const number = (value) => { formatters(); return integerFormat.format(value); };
  // A count phrase picks its One or Other catalogue form, so a single
  // contributor or sample never reads as plural.
  const countText = (key, count) => translate(`community.${key}${count === 1 ? "One" : "Other"}`, { count: number(count) });
  const metricNumber = (value, metric) => { formatters(); return (metric === "latency" ? numberFormat : integerFormat).format(value); };
  const fullDate = (value) => { formatters(); return fullDateFormat.format(value); };
  const visible = () => !root.classList.contains("dashboard-page-inactive") && !documentRef.hidden;
  const element = (name, className, text) => {
    const node = documentRef.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgElement = (name, attributes = {}, text) => {
    const node = documentRef.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const evidenceRow = (kind, label, value) => {
    const row = element("div", "performance-evidence-row");
    row.dataset.evidence = kind;
    row.append(element("dt", "performance-evidence-label", label), element("dd", "performance-evidence-value", value));
    return row;
  };
  const unitFor = metric => translate(metric === "latency" ? "latencyShortUnit" : "speedShortUnit");
  const estimateValue = (quantile, metric) => translate("community.estimateValue", {
    estimate: metricNumber(quantile.estimate, metric), lower: metricNumber(quantile.lower, metric),
    upper: metricNumber(quantile.upper, metric), unit: unitFor(metric),
  });
  // Tooltips, readouts and point labels show every estimate with its bounds,
  // for example "P50 62 (58-66) tokens/s", and whiskers draw the median's.
  // The endpoint labels beside the chart have no room for bounds, so they
  // mark each estimate approximate instead: "P50 ≈62 tokens/s". No estimate
  // is presented as exact.
  const estimateText = (label, quantile, metric) => translate("community.estimate", { label, value: estimateValue(quantile, metric) });
  const PERCENTILE_LABELS = [["median", "P50"], ["p10", "P10"], ["p25", "P25"], ["p75", "P75"], ["p90", "P90"]];
  const pointValues = (point, metric) => PERCENTILE_LABELS
    .filter(([key]) => point[key] !== null).map(([key, label]) => estimateText(label, point[key], metric)).join(" · ");
  const formatPoint = (point, metric) => {
    const text = translate("point", { date: fullDate(point.at), method: translate(metric), values: pointValues(point, metric), samples: countText("sampleCount", point.n) });
    return point.unresolved ? `${text} · ${translate("community.pointUnresolved", { count: number(point.unresolved) })}` : text;
  };
  const periodLabel = value => value === "1" ? translate("community.latestDay") : translate(value === "all" ? "all" : `days${value}`);
  function appendEvidence(container) {
    const { evidence } = display;
    const range = display.period === "1" ? fullDate(display.start)
      : display.period === "all" ? reportTranslate("allThrough", { end: fullDate(display.end) })
        : reportTranslate("range", { start: fullDate(display.start), end: fullDate(display.end) });
    formatters();
    const omitted = evidence.omittedModels.turns
      ? translate("community.omittedValue", { models: number(evidence.omittedModels.models), samples: countText("sampleCount", evidence.omittedModels.turns) })
      : number(evidence.omittedModels.models);
    container.append(
      evidenceRow("period", reportTranslate("period"), `${periodLabel(display.period)} · ${range}`),
      evidenceRow("contributors", translate("community.contributors"), number(evidence.contributors)),
      evidenceRow("installations", translate("community.installations"), number(evidence.devices)),
      evidenceRow("reports", translate("community.reports"), number(evidence.reports)),
      evidenceRow("samples", translate("turns"), number(evidence.samples)),
      evidenceRow("revision", translate("community.revision"), number(evidence.revision)),
      evidenceRow("updated", translate("community.updated"), dateTimeFormat.format(new Date(evidence.generatedAt))),
      evidenceRow("omitted", translate("community.omitted"), omitted),
    );
  }
  function plot(points, metric, color, domain, suffix) {
    const holder = element("div", "performance-plot");
    if (!points.length) { holder.append(element("p", "performance-empty", translate(metric === "speed" ? "combinedSpeedEmpty" : "ttftEmpty"))); return holder; }
    const svg = svgElement("svg", { viewBox: "0 0 800 256", role: "group", "aria-label": translate(metric) });
    formatters();
    const { start, end } = domain;
    const estimate = (point, key) => point[key].estimate;
    // The scale holds every drawn mark: the P90 estimate and the median bound whisker.
    const scale = performanceYScale(points.flatMap(point => [point.p90?.estimate ?? point.median.estimate, point.median.upper]));
    const axisNumber = new Intl.NumberFormat(locale(), { maximumFractionDigits: metric === "latency" ? Math.min(20, scale.digits) : 0 });
    const plotLeft = 52, plotRight = 708, plotWidth = plotRight - plotLeft;
    const x = value => plotLeft + Math.max(0, Math.min(1, (value - start) / Math.max(1, end - start))) * plotWidth;
    const y = value => 214 - value / scale.maximum * 190;
    const curve = (a, b, key, reverse = false) => {
      const ax = x(a.at), ay = y(estimate(a, key)), bx = x(b.at), by = y(estimate(b, key)), control = (bx - ax) / 3;
      return reverse
        ? `M${bx},${by} C${bx - control},${by} ${ax + control},${ay} ${ax},${ay}`
        : `M${ax},${ay} C${ax + control},${ay} ${bx - control},${by} ${bx},${by}`;
    };
    const band = (a, b, low, high) => `${curve(a, b, low)} L${x(b.at)},${y(estimate(b, high))} ${curve(a, b, high, true).slice(1)} Z`;
    for (const value of scale.ticks) {
      svg.append(svgElement("line", { x1: plotLeft, x2: plotRight, y1: y(value), y2: y(value), class: "performance-grid" }),
        svgElement("text", { x: 42, y: y(value) + 4, "text-anchor": "end", class: "performance-axis" }, axisNumber.format(value)));
    }
    const tickDate = new Intl.DateTimeFormat(locale(), { month: "short", ...(end - start > 730 * DAY ? { year: "numeric" } : { day: "numeric" }), timeZone: "UTC" });
    for (const at of performanceDateTicks(domain)) {
      const px = x(at);
      svg.append(svgElement("line", { x1: px, x2: px, y1: 24, y2: 214, class: "performance-grid performance-date-grid" }),
        svgElement("text", { x: px, y: 244, "text-anchor": px < 80 ? "start" : px > plotRight - 30 ? "end" : "middle", class: "performance-axis" }, tickDate.format(at)));
    }
    svg.append(svgElement("path", { d: `M${plotLeft} 24V214H${plotRight}`, class: "performance-axis-line", fill: "none" }));
    const readout = element("p", "sr-only performance-readout", "");
    readout.setAttribute("aria-live", "polite");
    const tooltip = element("div", "performance-tooltip"); tooltip.hidden = true;
    tooltip.setAttribute("aria-hidden", "true");
    const cursor = svgElement("line", { x1: 0, x2: 0, y1: 24, y2: 214, class: "performance-cursor", visibility: "hidden" });
    const defs = svgElement("defs");
    for (const [name, middleOpacity] of [["outer", .12], ["inner", .22]]) {
      const gradient = svgElement("linearGradient", { id: `performance-community-${name}-${suffix}`, x1: 0, y1: 0, x2: 0, y2: 1 });
      gradient.append(svgElement("stop", { offset: "0%", "stop-color": color, "stop-opacity": .035 }),
        svgElement("stop", { offset: "50%", "stop-color": color, "stop-opacity": middleOpacity }),
        svgElement("stop", { offset: "100%", "stop-color": color, "stop-opacity": .035 }));
      defs.append(gradient);
    }
    svg.append(defs);
    for (const segment of performanceSegments(points, display.interval)) {
      const a = segment.from, b = segment.to;
      if (!segment.dashed && a.p10 !== null && b.p10 !== null) {
        svg.append(svgElement("path", { d: band(a, b, "p10", "p90"), fill: `url(#performance-community-outer-${suffix})`, class: "performance-percentile-band performance-percentile-band-outer" }),
          svgElement("path", { d: band(a, b, "p25", "p75"), fill: `url(#performance-community-inner-${suffix})`, class: "performance-percentile-band performance-percentile-band-inner" }));
        for (const key of ["p10", "p25", "p75", "p90"]) svg.append(svgElement("path", {
          d: curve(a, b, key), fill: "none", stroke: color, class: `performance-percentile-line performance-percentile-line-${key}`,
        }));
      }
      svg.append(svgElement("path", { d: curve(a, b, "median"), fill: "none", stroke: color,
        class: `performance-median-line${segment.dashed ? " performance-median-line-gap" : ""}` }));
    }
    const markers = [];
    for (const point of points) {
      const cx = x(point.at), cy = y(point.median.estimate);
      if (point.p10 !== null) svg.append(svgElement("line", { x1: cx, x2: cx, y1: y(point.p10.estimate), y2: y(point.p90.estimate), stroke: color, class: "performance-percentile-range" }),
        svgElement("line", { x1: cx, x2: cx, y1: y(point.p25.estimate), y2: y(point.p75.estimate), stroke: color, class: "performance-quartile-range" }));
      // Every point, including one below five samples, shows its median bounds.
      const whisker = svgElement("g", { class: "performance-bound-whisker", "aria-hidden": "true" });
      whisker.append(svgElement("line", { x1: cx, x2: cx, y1: y(point.median.lower), y2: y(point.median.upper), stroke: color }),
        svgElement("line", { x1: cx - 5, x2: cx + 5, y1: y(point.median.lower), y2: y(point.median.lower), stroke: color }),
        svgElement("line", { x1: cx - 5, x2: cx + 5, y1: y(point.median.upper), y2: y(point.median.upper), stroke: color }));
      svg.append(whisker);
      const marker = svgElement("g", { tabindex: -1, role: "img", "aria-label": formatPoint(point, metric), class: "performance-point" });
      marker.dataset.performanceFocus = `point-${metric}-${point.at}`;
      marker.append(svgElement("circle", { cx, cy, r: 14, fill: "transparent", class: "performance-hit-target" }),
        svgElement("circle", { cx, cy, r: 4, fill: point.n < 5 ? "var(--surface-raised)" : color, stroke: color, "stroke-width": 1.8 }));
      marker.addEventListener("focus", () => {
        for (const entry of markers) entry.node.setAttribute("tabindex", entry.node === marker ? "0" : "-1");
        showInterval(point.at);
      });
      marker.addEventListener("keydown", event => {
        if (event.key === "Escape") { showInterval(null); return; }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const index = markers.findIndex(entry => entry.node === marker);
        const next = event.key === "Home" ? 0 : event.key === "End" ? markers.length - 1 : Math.max(0, Math.min(markers.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
        event.preventDefault(); markers[next]?.node.focus();
      });
      markers.push({ node: marker, at: point.at }); svg.append(marker);
    }
    markers[0]?.node.setAttribute("tabindex", "0");
    const latest = [...points].reverse().find(point => point.p10 !== null);
    if (latest) {
      const unit = unitFor(metric);
      const labels = [["p90", "P90"], ["p75", "P75"], ["median", "P50"], ["p25", "P25"], ["p10", "P10"]]
        .map(([key, label]) => ({ key, label, actualY: y(estimate(latest, key)), labelY: y(estimate(latest, key)) }))
        .sort((a, b) => a.labelY - b.labelY);
      for (let i = 1; i < labels.length; i++) labels[i].labelY = Math.max(labels[i].labelY, labels[i - 1].labelY + 13);
      const overflow = Math.max(0, labels.at(-1).labelY - 210);
      if (overflow) for (const label of labels) label.labelY -= overflow;
      const underflow = Math.max(0, 28 - labels[0].labelY);
      if (underflow) for (const label of labels) label.labelY += underflow;
      for (const label of labels) {
        svg.append(svgElement("line", { x1: x(latest.at) + 3, y1: label.actualY, x2: 717, y2: label.labelY, stroke: color, class: "performance-endpoint-leader", "aria-hidden": "true" }),
          svgElement("circle", { cx: x(latest.at), cy: label.actualY, r: label.key === "median" ? 3.2 : 2.4, fill: color, class: "performance-endpoint-dot", "aria-hidden": "true" }),
          svgElement("text", { x: 721, y: label.labelY + 4, fill: color, class: `performance-endpoint-label${label.key === "median" ? " performance-endpoint-label-median" : ""}`, "aria-hidden": "true" }, `${label.label} ≈${metricNumber(estimate(latest, label.key), metric)} ${unit}`));
      }
    }
    const highlight = svgElement("circle", { r: 8, fill: "none", stroke: color, "stroke-width": 2.5, visibility: "hidden", class: "performance-highlight" });
    svg.append(cursor, highlight);
    const byDate = new Map(points.map(point => [point.at, point]));
    chartCursors.push(at => {
      tooltip.hidden = at === null;
      cursor.setAttribute("visibility", at === null ? "hidden" : "visible");
      highlight.setAttribute("visibility", "hidden");
      if (at === null) { readout.textContent = ""; return; }
      cursor.setAttribute("x1", x(at)); cursor.setAttribute("x2", x(at));
      const point = byDate.get(at);
      tooltip.replaceChildren(element("strong", "performance-tooltip-date", fullDate(at)));
      readout.textContent = point ? formatPoint(point, metric) : `${fullDate(at)} · ${translate("noBin")}`;
      if (!point) tooltip.append(element("p", "", translate("noBin")));
      else {
        highlight.setAttribute("cx", x(at)); highlight.setAttribute("cy", y(point.median.estimate)); highlight.setAttribute("visibility", "visible");
        const row = element("div", "performance-tooltip-row");
        row.append(element("span", "performance-tooltip-method", metric === "latency" ? translate("latency") : translate("medianP50")),
          element("strong", "performance-tooltip-value", estimateText("P50", point.median, metric)));
        const distribution = element("div", "performance-tooltip-percentiles");
        if (point.p10 === null) distribution.append(element("span", "performance-tooltip-detail", translate("community.percentilesUnavailable")));
        else for (const [key, label] of [["p90", "P90"], ["p75", "P75"], ["p25", "P25"], ["p10", "P10"]]) {
          distribution.append(element("span", "", label), element("strong", "", estimateValue(point[key], metric)));
        }
        row.append(distribution, element("span", "performance-tooltip-detail", `${translate("turns")}: ${number(point.n)}`));
        if (point.unresolved) row.append(element("span", "performance-tooltip-detail performance-tooltip-unresolved", translate("community.pointUnresolved", { count: number(point.unresolved) })));
        tooltip.append(row);
      }
      const anchorY = point ? y(point.median.estimate) : 24;
      const bounds = svg.getBoundingClientRect();
      const anchorXCss = x(at) / 800 * bounds.width;
      const anchorYCss = anchorY / 256 * bounds.height;
      const tooltipHeight = tooltip.offsetHeight || 180;
      const vertical = bounds.top + anchorYCss >= tooltipHeight + 12 ? "above" : "below";
      const horizontal = anchorXCss >= bounds.width / 2 ? "before" : "after";
      tooltip.className = `performance-tooltip performance-tooltip-${horizontal} performance-tooltip-${vertical}`;
      tooltip.style.setProperty("--performance-tooltip-x", `${anchorXCss}px`);
      tooltip.style.setProperty("--performance-tooltip-y", `${anchorYCss}px`);
    });
    const sweep = event => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const px = (event.clientX - bounds.left) * 800 / bounds.width;
      const py = (event.clientY - bounds.top) * 256 / bounds.height;
      if (px < plotLeft || px > plotRight || py < 24 || py > 214) { showInterval(null); return; }
      showInterval(performanceHoverBin((px - plotLeft) / plotWidth, domain, display.interval));
    };
    svg.addEventListener("pointermove", sweep);
    svg.addEventListener("pointerdown", sweep);
    svg.addEventListener("pointerleave", () => { showInterval(null); });
    svg.addEventListener("focusout", event => { if (!svg.contains(event.relatedTarget)) showInterval(null); });
    holder.append(svg, tooltip, readout);
    return holder;
  }
  function render() {
    const activeFocus = documentRef.activeElement?.dataset?.performanceFocus;
    const restoreFocus = () => {
      if (activeFocus) [...root.querySelectorAll("[data-performance-focus]")]
        .find((node) => node.dataset.performanceFocus === activeFocus)?.focus({ preventScroll: true });
    };
    chartCursors = []; selectedInterval = null;
    root.replaceChildren();
    root.dataset.performanceSource = "community";
    const heading = element("div", "dashboard-page-header");
    const title = element("div");
    const h2 = element("h2", "", translate("title")); h2.id = "performance-title";
    h2.tabIndex = -1; h2.dataset.performanceFocus = "heading";
    title.append(h2, element("p", "page-description", translate("subtitle")));
    const periods = element("div", "segmented-control performance-periods"); periods.setAttribute("aria-label", translate("period")); periods.setAttribute("role", "group");
    for (const value of COMMUNITY_PERIODS) {
      const button = element("button", value === period ? "active" : "", periodLabel(value));
      button.type = "button"; button.setAttribute("aria-pressed", String(period === value)); button.dataset.performanceFocus = `period-${value}`;
      button.addEventListener("click", () => { if (period !== value) { period = value; selectSlot(); } });
      periods.append(button);
    }
    heading.append(title, periods);
    root.append(heading, element("p", "performance-provider", translate("provider")));
    if (period === "1") root.append(element("p", "performance-mode-note performance-period-note", translate("community.latestDayNote")));
    const modeControls = element("div", "performance-mode-controls");
    const modes = element("div", "segmented-control performance-modes");
    modes.setAttribute("role", "group"); modes.setAttribute("aria-label", translate("mode"));
    for (const value of SPEED_MODES) {
      const button = element("button", value === speedMode ? "active" : "", translate(value));
      button.type = "button"; button.setAttribute("aria-pressed", String(speedMode === value));
      button.dataset.performanceFocus = `mode-${value}`;
      button.addEventListener("click", () => { if (speedMode !== value) { speedMode = value; selectSlot(); } });
      modes.append(button);
    }
    modeControls.append(modes, element("p", "performance-mode-note", translate(`${speedMode}Note`)));
    root.append(modeControls);
    if (display?.excludedUnknownTurns) root.append(element("p", "performance-mode-note", translate("unknownMode", { count: number(display.excludedUnknownTurns) })));
    const status = element("p", "performance-status"); status.setAttribute("role", "status");
    const statusState = cancelled ? "cancelled" : failed ? "error" : loading && slotState === null ? "loading"
      : slotState === "none" ? "none" : slotState === "unsupported" ? "unsupported" : slotState === "published" ? "ready" : "";
    status.dataset.state = statusState;
    status.textContent = ({
      cancelled: translate("cancelled"), error: translate("community.failed"), loading: translate("community.loading"),
      none: translate("community.none"), unsupported: translate("community.unsupported"),
    })[statusState] ?? "";
    const actions = element("div", "dashboard-actions performance-actions");
    actions.append(status);
    root.append(actions);
    if (loading) {
      const cancel = element("button", "button button-secondary compact", translate("cancel")); cancel.type = "button"; cancel.dataset.performanceFocus = "cancel"; cancel.addEventListener("click", cancelRefresh); actions.append(cancel);
    } else if (failed || slotState === "unsupported") {
      const retry = element("button", "button button-secondary compact", translate("retry")); retry.type = "button"; retry.dataset.performanceFocus = "retry"; retry.addEventListener("click", refresh); actions.append(retry);
    }
    if (!display) { restoreFocus(); return; }
    const evidence = element("dl", "performance-evidence performance-community-evidence");
    appendEvidence(evidence);
    root.append(evidence);
    const models = display.models;
    if (!models.length) {
      const empty = element("p", "performance-empty", translate("modeEmpty", { mode: translate(speedMode) }));
      empty.dataset.state = "empty";
      root.append(empty);
      restoreFocus();
      return;
    }
    if (!models.some((model) => model.id === modelId)) modelId = models[0].id;
    const tabs = element("div", "performance-models"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", translate("models"));
    models.forEach((model, index) => {
      const presentation = modelUsagePresentation(model.id);
      const button = element("button", `performance-model ${presentation.className}`); button.type = "button";
      const icon = modelThemeIcon(documentRef, presentation.theme);
      if (icon) { icon.setAttribute("class", `allowance-model-icon performance-model-icon ${presentation.className}`); button.append(icon); }
      button.append(element("span", "", model.label));
      button.setAttribute("aria-label", model.label);
      button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(model.id === modelId)); button.setAttribute("aria-controls", "performance-model-panel"); button.tabIndex = model.id === modelId ? 0 : -1;
      button.id = `performance-tab-${index}`; button.dataset.performanceFocus = `model-${model.id}`;
      button.addEventListener("click", () => { modelId = model.id; render(); });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? models.length - 1 : (index + (event.key === "ArrowRight" ? 1 : models.length - 1)) % models.length;
        modelId = models[next].id; render(); documentRef.getElementById?.(`performance-tab-${next}`)?.focus();
      });
      tabs.append(button);
    });
    root.append(tabs);
    const selectedIndex = models.findIndex((model) => model.id === modelId), selected = models[selectedIndex];
    const selectedPresentation = modelUsagePresentation(selected.id);
    const domain = communityDomain(display, selected);
    const panel = element("div", `performance-model-panel ${selectedPresentation.className}`); panel.id = "performance-model-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `performance-tab-${selectedIndex}`);
    const subheading = element("div", "performance-model-heading"), identity = element("h3", "performance-model-identity");
    const selectedIcon = modelThemeIcon(documentRef, selectedPresentation.theme);
    if (selectedIcon) { selectedIcon.setAttribute("class", `allowance-model-icon performance-model-icon ${selectedPresentation.className}`); identity.append(selectedIcon); }
    identity.append(element("span", "", selected.label));
    subheading.append(identity, element("span", "", translate(display.interval))); panel.append(subheading);
    const sources = element("p", "performance-unit performance-model-sources", translate("community.modelSources", { contributors: countText("contributorCount", selected.contributors), devices: countText("installationCount", selected.devices) }));
    panel.append(sources);
    for (const metric of ["speed", "latency"]) {
      const card = element("article", "performance-card chart-card");
      const cardHeading = element("div", "performance-card-heading chart-card-header"), cardTitle = element("div");
      const summary = metric === "speed"
        ? translate("community.speedSummary", { measured: number(selected.speedTurns), samples: countText("sampleCount", selected.turns), estimates: countText("estimateCount", selected.toolFreeTurns) })
        : translate("community.latencySummary", { measured: number(selected.ttftTurns), samples: countText("sampleCount", selected.turns), responses: countText("responseCount", selected.timedResponses) });
      const coverage = element("p", "performance-unit", summary);
      coverage.dataset.state = (metric === "speed" ? selected.speedTurns : selected.ttftTurns) < selected.turns ? "partial" : "complete";
      cardTitle.append(element("h4", "chart-card-title", translate(metric)), coverage);
      if (metric === "speed" && selected.unresolved > 0)
        cardTitle.append(element("p", "performance-method-note performance-unresolved-note", countText("unresolved", selected.unresolved)));
      const legend = element("div", "performance-legend chart-card-legend");
      for (const method of ["outerBand", "innerBand", "medianP50", "community.bounds"]) {
        const entry = element("span", "performance-legend-item");
        const color = "var(--allowance-color)";
        const swatch = svgElement("svg", { width: method === "outerBand" || method === "innerBand" ? 22 : 24, height: 16, viewBox: "0 0 24 16", "aria-hidden": "true" });
        if (method === "community.bounds") {
          swatch.append(svgElement("path", { d: "M12 2V14M8 2H16M8 14H16", fill: "none", stroke: color, "stroke-width": 1.6 }));
        } else swatch.append(svgElement(method === "medianP50" ? "line" : "rect", {
          ...(method === "medianP50" ? { x1: 1, y1: 8, x2: 23, y2: 8 } : { x: 1, y: method === "outerBand" ? 3 : 5, width: 22, height: method === "outerBand" ? 10 : 6, rx: 3 }),
          fill: color, stroke: color, opacity: method === "outerBand" ? .1 : method === "innerBand" ? .22 : 1,
          "stroke-width": method === "medianP50" ? 2.6 : 0,
        }));
        entry.append(swatch, element("span", "", translate(method))); legend.append(entry);
      }
      cardHeading.append(cardTitle);
      card.append(cardHeading, legend, plot(metric === "speed" ? selected.speed : selected.ttft, metric, "var(--allowance-color)", domain, `${metric}-${selectedIndex}`));
      panel.append(card);
    }
    const aboutSummary = element("summary", "", translate("about")); aboutSummary.dataset.performanceFocus = "about";
    const about = element("details", "performance-details"); about.open = aboutOpen;
    about.append(aboutSummary, element("p", "", translate("methodology")), element("p", "", translate("variance")));
    about.addEventListener("toggle", () => { aboutOpen = about.open; });
    panel.append(about);
    root.append(panel);
    restoreFocus();
  }
  const abortPending = () => { pending?.abort(); pending = null; };
  const schedule = (delay) => {
    windowRef.clearTimeout(timer); timer = null;
    if (!destroyed && visible()) timer = windowRef.setTimeout(refresh, Math.max(0, delay));
  };
  // A slot answers with its own normalized state; anything else is refused.
  function outcomeFor(result, slot) {
    if (!result || typeof result !== "object" || result.period !== slot.period || result.speedMode !== slot.speedMode) return { state: "unsupported" };
    if (result.state === "published") {
      const next = normalizeCommunityPerformanceDisplay(result);
      return next && next.period === slot.period && next.speedMode === slot.speedMode
        ? { state: "published", display: next } : { state: "unsupported" };
    }
    if (result.state === "none_published") return { state: "none" };
    if (result.state === "service_unavailable") return { state: "failed" };
    return { state: "unsupported" };
  }
  function apply(outcome) {
    if (outcome.state === "failed") { failed = true; return; }
    slotState = outcome.state;
    display = outcome.state === "published" ? outcome.display : null;
  }
  function remember(key, outcome) {
    slots.delete(key);
    slots.set(key, { outcome, cachedAt: Date.now() });
    while (slots.size > COMMUNITY_MAX_SLOTS) slots.delete(slots.keys().next().value);
  }
  async function refresh() {
    if (!visible() || destroyed) return;
    const current = ++request, startedLifecycle = lifecycle;
    const slot = { period, speedMode }, key = slotKey();
    windowRef.clearTimeout(timer); timer = null;
    abortPending();
    const hadFailure = failed;
    loading = true; failed = false; cancelled = false;
    // A shown slot stays visible while its replacement is fetched.
    if (!display || hadFailure) render();
    const controller = new AbortController();
    let timedOut = false;
    const deadline = windowRef.setTimeout(() => { timedOut = true; controller.abort(); }, COMMUNITY_REQUEST_TIMEOUT_MS);
    pending = controller;
    let outcome;
    try {
      outcome = outcomeFor(await client.modelPerformance(slot.period, { signal: controller.signal, speedMode: slot.speedMode }), slot);
      // A client that ignores AbortSignal may resolve late; that answer is not fresh.
      if (controller.signal.aborted) outcome = timedOut ? { state: "failed" } : null;
    } catch {
      outcome = controller.signal.aborted && !timedOut ? null : { state: "failed" };
    } finally {
      windowRef.clearTimeout(deadline);
      if (pending === controller) pending = null;
    }
    if (request !== current || lifecycle !== startedLifecycle || destroyed || outcome === null) return;
    loading = false;
    if (outcome.state === "published" || outcome.state === "none") remember(key, outcome);
    apply(outcome);
    render();
    schedule(refreshIntervalMs);
  }
  // Switching slots shows a cached answer for that slot only; it never warms others.
  function selectSlot() {
    request++;
    abortPending();
    windowRef.clearTimeout(timer); timer = null;
    loading = false; failed = false; cancelled = false;
    const cached = slots.get(slotKey());
    display = null; slotState = null;
    if (cached) apply(cached.outcome);
    render();
    const age = cached ? Date.now() - cached.cachedAt : Infinity;
    if (age < refreshIntervalMs) schedule(refreshIntervalMs - age);
    else void refresh();
  }
  function resume() {
    if (loading || destroyed || !visible()) return;
    const cached = slots.get(slotKey());
    const age = cached ? Date.now() - cached.cachedAt : Infinity;
    if (age < refreshIntervalMs && slotState !== null && !failed) schedule(refreshIntervalMs - age);
    else void refresh();
  }
  function suspend() {
    windowRef.clearTimeout(timer); timer = null;
    request++;
    abortPending();
    loading = false;
  }
  function cancelRefresh() {
    if (!loading) return;
    request++;
    abortPending();
    windowRef.clearTimeout(timer); timer = null;
    loading = false; failed = false; cancelled = true;
    render();
  }
  const rootVisibilityChanged = () => { if (visible()) resume(); else suspend(); };
  const documentVisibilityChanged = () => {
    if (documentRef.hidden) { lifecycle++; suspend(); }
    else resume();
  };
  const observer = new windowRef.MutationObserver(rootVisibilityChanged);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  documentRef.addEventListener("visibilitychange", documentVisibilityChanged);
  render();
  if (visible()) void refresh();
  return {
    render,
    refresh,
    // Only the selected slot is ever requested; there is nothing to warm.
    preload: () => Promise.resolve(false),
    setReportingWindow() { return false; },
    cancel: cancelRefresh,
    destroy() {
      destroyed = true;
      lifecycle++;
      slots.clear();
      display = null;
      observer.disconnect();
      abortPending();
      request++;
      windowRef.clearTimeout(timer); timer = null;
      documentRef.removeEventListener("visibilitychange", documentVisibilityChanged);
    },
  };
}
