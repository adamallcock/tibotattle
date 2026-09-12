import { modelUsagePresentation, modelThemeIcon } from "./model-visuals.js";
import { formatModelName } from "./ui-format.js";

// Presentation-only: the companion owns reconstruction, eligibility and bins.
const DAY = 86_400_000;
const PERIODS = ["7", "30", "all"];
const SPEED_METHOD = "speed";
const MODEL_NAMES = Object.freeze({
  "gpt-5.6-luna": "Luna", "gpt-5.6-terra": "Terra", "gpt-5.6-sol": "Sol",
  "gpt-6-astra": "Astra", "gpt-5.5": "GPT-5.5", "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini", "gpt-5.3-codex-spark": "Spark",
  "gpt-5.3-codex": "GPT-5.3 Codex", "gpt-5.2-codex": "GPT-5.2 Codex", "gpt-5.2": "GPT-5.2",
});
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** A closed, bounded display contract: never pass arbitrary source text to DOM. */
export function normalizeModelPerformance(value) {
  if (!exact(value, ["schemaVersion", "method", "status", "collecting", "stale", "updatedAt", "period", "interval", "start", "end", "historyProgress", "models"])
      || value.schemaVersion !== 2 || value.method !== 3 || !["ready", "loading", "unavailable"].includes(value.status)
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
    if (!exact(model, ["id", "label", "turns", "speedTurns", "ttftTurns", "timedResponses", "speed", "ttft"])
        || !Object.hasOwn(MODEL_NAMES, model.id) || model.label !== MODEL_NAMES[model.id] || seen.has(model.id)
        || ![model.turns, model.speedTurns, model.ttftTurns, model.timedResponses].every(count)
        || model.speedTurns > model.turns || model.ttftTurns > model.turns
        || !Array.isArray(model.speed) || model.speed.length > 1 || !validPoints(model.ttft, model.ttftTurns)) return null;
    seen.add(model.id);
    let speedCount = 0;
    for (const series of model.speed) {
      if (!exact(series, ["method", "points"]) || series.method !== SPEED_METHOD
          || !validPoints(series.points, model.speedTurns)) return null;
      speedCount += series.points.reduce((sum, point) => sum + point.n, 0);
    }
    if (speedCount > model.speedTurns) return null;
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

/** All-time focuses this model's measured era; both metrics retain one domain. */
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

export function mountModelPerformance({ root, client, t, locale = () => "en-US", windowRef = globalThis.window }) {
  if (!root) return { render() {}, refresh() {} };
  const documentRef = root.ownerDocument;
  const storageKey = "tibotattle.performance.v1";
  let saved = {};
  try { saved = JSON.parse(windowRef.localStorage.getItem(storageKey)) ?? {}; } catch { /* Storage can be disabled. */ }
  let period = PERIODS.includes(saved.period) ? saved.period : "all";
  let modelId = Object.hasOwn(MODEL_NAMES, saved.model) ? saved.model : null;
  let payload = null, loading = false, failed = false, request = 0, abort = null, timer = null;
  // At most the three fixed periods, retained only for this mounted local view.
  // No measurements or identity-bearing data enter browser storage.
  const readyPeriods = new Map();
  let aboutOpen = false, chartCursors = [];
  let selectedInterval = null;
  const showInterval = (at) => { if (at === selectedInterval) return; selectedInterval = at; for (const update of chartCursors) update(at); };
  const translate = (key, values) => t(`performance.${key}`, values);
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
  const metricNumber = (value, metric) => { formatters(); return (metric === "speed" ? integerFormat : numberFormat).format(value); };
  const date = (value) => { formatters(); return dateFormat.format(value); };
  const visible = () => !root.classList.contains("dashboard-page-inactive") && !documentRef.hidden;
  const remember = () => { try { windowRef.localStorage.setItem(storageKey, JSON.stringify({ period, model: modelId })); } catch { /* Nonessential preference. */ } };
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
  function plot(series, metric, color, domain) {
    const holder = element("div", "performance-plot");
    const points = series.flatMap((item) => item.points);
    if (!points.length) { holder.append(element("p", "performance-empty", translate(metric === "speed" ? "speedEmpty" : "ttftEmpty"))); return holder; }
    const svg = svgElement("svg", { viewBox: "0 0 800 256", role: "group", "aria-label": translate(metric === "speed" ? "speed" : "latency") });
    formatters();
    const { start, end } = domain;
    const scale = performanceYScale(points.map(point => point.p90 ?? point.median));
    const axisNumber = new Intl.NumberFormat(locale(), { maximumFractionDigits: metric === "speed" ? 0 : Math.min(20, scale.digits) });
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
    const formatPoint = (point, method) => translate("point", { date: fullDateFormat.format(point.at), method: method === "ttft" ? translate("latency") : translate("speed"), median: metricNumber(point.median, metric), percentiles: percentileValues(point), count: number(point.n) });
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
      const unit = translate(metric === "speed" ? "speedShortUnit" : "latencyShortUnit");
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
        const unit = translate(metric === "speed" ? "speedShortUnit" : "latencyShortUnit");
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
    const heading = element("div", "performance-heading");
    const title = element("div");
    const h2 = element("h2", "", translate("title")); h2.id = "performance-title";
    h2.tabIndex = -1; h2.dataset.performanceFocus = "heading";
    title.append(h2, element("p", "performance-subtitle", translate("subtitle")), element("p", "performance-provider", translate("provider")));
    const periods = element("div", "segmented-control performance-periods"); periods.setAttribute("aria-label", translate("period")); periods.setAttribute("role", "group");
    for (const value of PERIODS) {
      const button = element("button", value === period ? "active" : "", translate(value === "all" ? "all" : `days${value}`));
      button.type = "button"; button.setAttribute("aria-pressed", String(period === value)); button.dataset.performanceFocus = `period-${value}`;
      button.addEventListener("click", () => { if (period === value) return; period = value; payload = readyPeriods.get(value) ?? null; remember(); render(); refresh(); }); periods.append(button);
    }
    heading.append(title, periods); root.append(heading);
    const status = element("p", "performance-status"); status.setAttribute("role", "status");
    const progress = payload?.historyProgress;
    const collectingLabel = progress?.total
      ? translate("buildingHistory", { checked: number(progress.checked), total: number(progress.total) })
      : translate("updating");
    status.textContent = failed ? translate("failed") : loading && !payload ? translate("loading") : payload?.collecting || payload?.status === "loading" ? collectingLabel : payload?.status === "unavailable" ? translate("unavailable") : payload?.updatedAt ? translate("updated", { date: new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(payload.updatedAt)) }) : "";
    root.append(status);
    if (payload?.stale) root.append(element("p", "performance-status", translate("stale")));
    if (failed || payload?.status === "unavailable") {
      const retry = element("button", "button button-secondary compact", translate("retry")); retry.type = "button"; retry.dataset.performanceFocus = "retry"; retry.addEventListener("click", refresh); root.append(retry);
    }
    const models = payload?.models ?? [];
    if (!models.length) {
      if (payload?.status === "ready") root.append(element("p", "performance-empty", translate("empty")));
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
      const card = element("article", "performance-card");
      const cardHeading = element("div", "performance-card-heading"), cardTitle = element("div");
      const summary = metric === "speed"
        ? translate("speedSummary", { measured: number(selected.speedTurns), total: number(selected.turns) })
        : translate("latencySummary", { measured: number(selected.ttftTurns), total: number(selected.turns), responses: number(selected.timedResponses) });
      cardTitle.append(element("h4", "", translate(metric)), element("p", "performance-unit", summary));
      const legend = element("div", "performance-legend");
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
      cardHeading.append(cardTitle, legend); card.append(cardHeading,
        plot(metric === "speed" ? selected.speed : [{ method: "ttft", points: selected.ttft }], metric, "var(--allowance-color)", domain));
      panel.append(card);
    }
    const aboutSummary = element("summary", "", translate("about")); aboutSummary.dataset.performanceFocus = "about";
    const about = element("details", "performance-details"); about.open = aboutOpen; about.append(aboutSummary, element("p", "", translate("methodology")), element("p", "", translate("variance"))); about.addEventListener("toggle", () => { aboutOpen = about.open; }); panel.append(about);
    root.append(panel);
    restoreFocus();
  }
  async function refresh() {
    if (!visible()) return;
    const current = ++request; abort?.abort(); abort = new AbortController();
    const controller = abort;
    const deadline = windowRef.setTimeout(() => controller.abort(), 15_000);
    const hadFailure = failed;
    loading = true; failed = false; windowRef.clearTimeout(timer);
    if (!payload || hadFailure) render();
    let changed = false;
    try {
      const result = normalizeModelPerformance(await client.modelPerformance(period, { signal: abort.signal }));
      if (request !== current) return;
      if (!result || result.period !== period) throw new Error("Invalid timing contract");
      if (result.status === "unavailable") readyPeriods.clear();
      else if (result.status === "ready") readyPeriods.set(period, result);
      const retained = result.status === "loading" ? readyPeriods.get(period) : null;
      const next = retained ? { ...retained, collecting: true, stale: true } : result;
      changed = JSON.stringify({ ...next, updatedAt: null }) !== JSON.stringify(payload ? { ...payload, updatedAt: null } : null);
      payload = next;
    } catch { if (request !== current) return; failed = true; }
    finally {
      windowRef.clearTimeout(deadline);
      if (request === current) {
        loading = false; if (changed || failed || !payload) render();
        if (visible()) timer = windowRef.setTimeout(refresh, failed ? 30_000 : 10_000);
      }
    }
  }
  const visibilityChanged = () => {
    if (visible()) { if (!loading) refresh(); }
    else { windowRef.clearTimeout(timer); abort?.abort(); request++; loading = false; }
  };
  const observer = new windowRef.MutationObserver(visibilityChanged);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  documentRef.addEventListener("visibilitychange", visibilityChanged);
  render(); if (visible()) refresh();
  return { render, refresh, destroy() { readyPeriods.clear(); payload = null; observer.disconnect(); abort?.abort(); request++; windowRef.clearTimeout(timer); documentRef.removeEventListener("visibilitychange", visibilityChanged); } };
}
