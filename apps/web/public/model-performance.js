// Presentation-only: the companion owns reconstruction, eligibility and bins.
const DAY = 86_400_000;
const PERIODS = ["7", "30", "all"];
const METHODS = ["receipt", "legacy"];
const MODEL_NAMES = Object.freeze({
  "gpt-5.6-luna": "Luna", "gpt-5.6-terra": "Terra", "gpt-5.6-sol": "Sol",
  "gpt-6-astra": "Astra", "gpt-5.5": "GPT-5.5", "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini", "gpt-5.3-codex-spark": "Spark",
  "gpt-5.3-codex": "GPT-5.3 Codex", "gpt-5.2-codex": "GPT-5.2 Codex", "gpt-5.2": "GPT-5.2",
});
const COLORS = { "gpt-5.6-luna": "#326a92", "gpt-5.6-terra": "#a47823", "gpt-6-astra": "#aa533b", "gpt-5.6-sol": "#737d35" };
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** A closed, bounded display contract: never pass arbitrary source text to DOM. */
export function normalizeModelPerformance(value) {
  if (!exact(value, ["schemaVersion", "method", "status", "collecting", "stale", "updatedAt", "period", "interval", "start", "end", "models"])
      || value.schemaVersion !== 1 || value.method !== 2 || !["ready", "loading", "unavailable"].includes(value.status)
      || typeof value.collecting !== "boolean" || typeof value.stale !== "boolean" || !PERIODS.includes(value.period)
      || !["day", "week"].includes(value.interval) || !timestamp(value.end)
      || !(value.start === null || timestamp(value.start) && value.start <= value.end)
      || !(value.updatedAt === null || typeof value.updatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value.updatedAt) && Number.isFinite(Date.parse(value.updatedAt)))
      || !Array.isArray(value.models) || value.models.length > 16) return null;
  const step = value.interval === "week" ? 7 * DAY : DAY;
  const seen = new Set();
  const validPoints = (points, maximum) => {
    if (!Array.isArray(points) || points.length > 2048) return false;
    let previous = -1, total = 0;
    for (const point of points) {
      if (!exact(point, ["at", "n", "median", "p25", "p75"]) || !timestamp(point.at)
          || point.at <= previous || point.at > value.end || (value.start !== null && point.at < value.start - step)
          || !count(point.n) || point.n < 1 || !Number.isFinite(point.median) || point.median < 0
          || point.median > 1e9) return false;
      if (point.n < 5 ? point.p25 !== null || point.p75 !== null
        : !Number.isFinite(point.p25) || !Number.isFinite(point.p75) || point.p25 < 0 || point.p25 > point.median || point.p75 < point.median || point.p75 > 1e9) return false;
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
        || !Array.isArray(model.speed) || model.speed.length > 2 || !validPoints(model.ttft, model.ttftTurns)) return null;
    seen.add(model.id);
    const methods = new Set();
    let speedCount = 0;
    for (const series of model.speed) {
      if (!exact(series, ["method", "points"]) || !METHODS.includes(series.method) || methods.has(series.method)
          || !validPoints(series.points, model.speedTurns)) return null;
      methods.add(series.method);
      speedCount += series.points.reduce((sum, point) => sum + point.n, 0);
    }
    if (speedCount > model.speedTurns) return null;
  }
  return value;
}

/** Separate segments at missing evidence; never join two reconstruction methods. */
export function performanceSegments(points, interval) {
  const step = interval === "week" ? 7 * DAY : DAY;
  return points.slice(1).flatMap((point, index) => {
    const previous = points[index], gap = point.at - previous.at;
    if (gap > step + 7 * DAY) return [];
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
  let tableOpen = false, aboutOpen = false, chartCursors = [];
  let selectedInterval = null;
  const showInterval = (at) => { if (at === selectedInterval) return; selectedInterval = at; for (const update of chartCursors) update(at); };
  const translate = (key, values) => t(`performance.${key}`, values);
  let formatterLocale, numberFormat, dateFormat, fullDateFormat;
  function formatters() {
    const selectedLocale = locale();
    if (formatterLocale !== selectedLocale) {
      formatterLocale = selectedLocale;
      numberFormat = new Intl.NumberFormat(selectedLocale, { maximumFractionDigits: 1 });
      dateFormat = new Intl.DateTimeFormat(selectedLocale, { month: "short", day: "numeric", timeZone: "UTC" });
      fullDateFormat = new Intl.DateTimeFormat(selectedLocale, { dateStyle: "medium", timeZone: "UTC" });
    }
  }
  const number = (value) => { formatters(); return numberFormat.format(value); };
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
    const scale = performanceYScale(points.map(point => point.p75 ?? point.median));
    const axisNumber = new Intl.NumberFormat(locale(), { maximumFractionDigits: Math.min(20, scale.digits) });
    const x = value => 52 + Math.max(0, Math.min(1, (value - start) / Math.max(1, end - start))) * 730;
    const y = value => 214 - value / scale.maximum * 190;
    for (const value of scale.ticks) {
      svg.append(svgElement("line", { x1: 52, x2: 782, y1: y(value), y2: y(value), class: "performance-grid" }),
        svgElement("text", { x: 42, y: y(value) + 4, "text-anchor": "end", class: "performance-axis" }, axisNumber.format(value)));
    }
    const dateTicks = performanceDateTicks(domain);
    const tickDate = new Intl.DateTimeFormat(locale(), { month: "short", ...(end - start > 730 * DAY ? { year: "numeric" } : { day: "numeric" }), timeZone: "UTC" });
    for (const at of dateTicks) {
      const px = x(at);
      svg.append(svgElement("line", { x1: px, x2: px, y1: 24, y2: 214, class: "performance-grid performance-date-grid" }),
        svgElement("text", { x: px, y: 244, "text-anchor": px < 80 ? "start" : px > 750 ? "end" : "middle", class: "performance-axis" }, tickDate.format(at)));
    }
    svg.append(svgElement("path", { d: "M52 24V214H782", class: "performance-axis-line", fill: "none" }));
    const readout = element("p", "sr-only performance-readout", "");
    readout.setAttribute("aria-live", "polite");
    const tooltip = element("div", "performance-tooltip"); tooltip.hidden = true;
    tooltip.setAttribute("aria-hidden", "true");
    const formatPoint = (point, method) => translate("point", { date: fullDateFormat.format(point.at), method: method === "ttft" ? translate("latencyUnit") : `${translate(method)} · ${translate("speedUnit")}`, median: number(point.median), spread: point.p25 === null ? "—" : `${number(point.p25)}–${number(point.p75)}`, count: number(point.n) });
    const cursor = svgElement("line", { x1: 0, x2: 0, y1: 24, y2: 214, class: "performance-cursor", visibility: "hidden" });
    const markers = [];
    for (const item of series) {
      for (const segment of performanceSegments(item.points, payload.interval)) {
        const a = segment.from, b = segment.to;
        if (!segment.dashed && a.p25 !== null && b.p25 !== null) {
          svg.append(svgElement("polygon", { points: `${x(a.at)},${y(a.p25)} ${x(b.at)},${y(b.p25)} ${x(b.at)},${y(b.p75)} ${x(a.at)},${y(a.p75)}`, fill: color, opacity: item.method === "legacy" ? .14 : .18 }));
        }
        svg.append(svgElement("line", { x1: x(a.at), y1: y(a.median), x2: x(b.at), y2: y(b.median), stroke: color, "stroke-width": 2.3, ...(segment.dashed ? { "stroke-dasharray": "5 5" } : {}) }));
      }
      for (const point of item.points) {
        const cx = x(point.at), cy = y(point.median);
        const marker = svgElement("g", { tabindex: -1, role: "img", "aria-label": formatPoint(point, item.method), class: "performance-point" });
        marker.dataset.performanceFocus = `point-${metric}-${item.method}-${point.at}`;
        // Pointer targets are independent of visible marker size; the whole plot
        // also accepts a horizontal sweep, including dates without evidence.
        marker.append(svgElement("circle", { cx, cy, r: 14, fill: "transparent", class: "performance-hit-target" }));
        marker.append(svgElement(item.method === "legacy" ? "polygon" : "circle", {
          ...(item.method === "legacy" ? { points: `${cx},${cy - 5} ${cx - 5},${cy + 4.5} ${cx + 5},${cy + 4.5}` } : { cx, cy, r: 4 }),
          fill: point.n < 5 ? "var(--white)" : color, stroke: color, "stroke-width": 1.8,
        }));
        if (point.p25 !== null) svg.append(svgElement("line", { x1: cx, x2: cx, y1: y(point.p25), y2: y(point.p75), stroke: color, "stroke-width": 5, opacity: .18 }));
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
        row.append(element("span", "performance-tooltip-method", method === "ttft" ? translate("latency") : translate(method)),
          element("strong", "performance-tooltip-value", `${number(point.median)} ${translate(metric === "speed" ? "speedShortUnit" : "latencyShortUnit")}`),
          element("span", "performance-tooltip-detail", `${translate("spread")}: ${point.p25 === null ? "—" : `${number(point.p25)}–${number(point.p75)}`} · ${translate("turns")}: ${number(point.n)}`));
        tooltip.append(row);
      }
      tooltip.style.setProperty("left", `clamp(0px, ${x(at) / 8 + 2}%, max(0px, 100% - 280px))`);
    });
    const sweep = event => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const px = (event.clientX - bounds.left) * 800 / bounds.width;
      const py = (event.clientY - bounds.top) * 256 / bounds.height;
      if (px < 52 || px > 782 || py < 24 || py > 214) { showInterval(null); return; }
      showInterval(performanceHoverBin((px - 52) / 730, domain, payload.interval));
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
      button.addEventListener("click", () => { if (period === value) return; period = value; payload = null; remember(); refresh(); }); periods.append(button);
    }
    heading.append(title, periods); root.append(heading);
    const status = element("p", "performance-status"); status.setAttribute("role", "status");
    status.textContent = failed ? translate("failed") : loading && !payload ? translate("loading") : payload?.collecting || payload?.status === "loading" ? translate("updating") : payload?.status === "unavailable" ? translate("unavailable") : payload?.updatedAt ? translate("updated", { date: new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(payload.updatedAt)) }) : "";
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
    if (!models.some((model) => model.id === modelId)) modelId = [...models].reverse().find((model) => Object.hasOwn(COLORS, model.id))?.id ?? models[0].id;
    const tabs = element("div", "performance-models"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", translate("models"));
    for (const model of models) {
      const button = element("button", "performance-model", model.label); button.type = "button";
      button.style.setProperty("--model-color", COLORS[model.id] ?? "var(--green)");
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
    const domain = performanceDomain(payload, selected);
    const panel = element("div", "performance-model-panel"); panel.id = "performance-model-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `performance-tab-${modelId}`);
    const subheading = element("div", "performance-model-heading"); subheading.append(element("h3", "", selected.label), element("span", "", translate(payload.interval))); panel.append(subheading);
    for (const metric of ["speed", "latency"]) {
      const card = element("article", "performance-card"); card.append(element("h4", "", translate(metric)), element("p", "performance-unit", translate(`${metric}Unit`)));
      card.append(plot(metric === "speed" ? selected.speed : [{ method: "ttft", points: selected.ttft }], metric, COLORS[modelId] ?? "var(--green)", domain));
      const legend = element("div", "performance-legend");
      for (const method of metric === "speed" ? ["receipt", "legacy", "band"] : ["band"]) {
        const entry = element("span", "performance-legend-item");
        const swatch = svgElement("svg", { width: 18, height: 16, viewBox: "0 0 18 16", "aria-hidden": "true" });
        const color = COLORS[modelId] ?? "var(--green)";
        swatch.append(svgElement(method === "band" ? "rect" : method === "legacy" ? "polygon" : "circle", {
          ...(method === "band" ? { x: 1, y: 3, width: 16, height: 10, rx: 2, opacity: .22 } : method === "legacy" ? { points: "9,3 4,12 14,12" } : { cx: 9, cy: 8, r: 4 }),
          fill: method === "band" ? color : "var(--white)", stroke: color, "stroke-width": method === "band" ? 0 : 2,
        }));
        entry.append(swatch, element("span", "", translate(method))); legend.append(entry);
      }
      card.append(legend); panel.append(card);
    }
    const coverage = element("div", "performance-coverage");
    coverage.append(element("span", "", translate("coverageSpeed", { measured: number(selected.speedTurns), total: number(selected.turns) })), element("span", "", translate("coverageTtft", { measured: number(selected.ttftTurns), total: number(selected.turns) })), element("span", "", translate("responses", { count: number(selected.timedResponses) }))); panel.append(coverage);
    const aboutSummary = element("summary", "", translate("about")); aboutSummary.dataset.performanceFocus = "about";
    const about = element("details", "performance-details"); about.open = aboutOpen; about.append(aboutSummary, element("p", "", translate("methodology")), element("p", "", translate("variance"))); about.addEventListener("toggle", () => { aboutOpen = about.open; }); panel.append(about);
    const tableSummary = element("summary", "", translate("table")); tableSummary.dataset.performanceFocus = "table";
    const details = element("details", "performance-details"); details.open = tableOpen; details.append(tableSummary);
    const tableWrap = element("div", "performance-table-wrap"), table = element("table", "performance-table"), head = element("thead"), header = element("tr");
    table.append(element("caption", "sr-only", `${selected.label} · ${translate("table")}`));
    for (const key of ["date", "metric", "median", "spread", "turns"]) { const cell = element("th", "", translate(key)); cell.scope = "col"; header.append(cell); }
    head.append(header); table.append(head); const body = element("tbody");
    for (const series of [...selected.speed, { method: "ttft", points: selected.ttft }]) for (const point of series.points) {
      const row = element("tr");
      for (const text of [fullDateFormat.format(point.at), series.method === "ttft" ? translate("latencyUnit") : `${translate(series.method)} · ${translate("speedUnit")}`, number(point.median), point.p25 === null ? "—" : `${number(point.p25)}–${number(point.p75)}`, number(point.n)]) row.append(element("td", "", text));
      body.append(row);
    }
    table.append(body); tableWrap.append(table); details.append(tableWrap); details.addEventListener("toggle", () => { tableOpen = details.open; }); panel.append(details); root.append(panel);
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
      changed = JSON.stringify({ ...result, updatedAt: null }) !== JSON.stringify(payload ? { ...payload, updatedAt: null } : null);
      payload = result;
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
  return { render, refresh, destroy() { observer.disconnect(); abort?.abort(); request++; windowRef.clearTimeout(timer); documentRef.removeEventListener("visibilitychange", visibilityChanged); } };
}
